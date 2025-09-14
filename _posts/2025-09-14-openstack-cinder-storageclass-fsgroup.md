---
layout: post
title: "OpenStack Cinder Storageclass fsGroup Troubleshooting"
date: 2025-09-14 09:51:00 +0900
categories: [Kubernetes]
tags: [openstack, storageclass, k8s, troubleshooting]
excerpt: "Storageclass로 OpenStack Cinder CSI Driver로 사용하며 겪은 트러블슈팅을 공유합니다."
---

## 들어가며

### OpenStack 소개

현재 제가 운영하고 있는 환경은 OpenStack 기반의 프라이빗 클라우드입니다. OpenStack은 클라우드 컴퓨팅의 등장과 AWS 같은 상용 클라우드의 확산에 대응하기 위해 미국의 Rackspace와 NASA가 공동 개발한 오픈소스 클라우드 플랫폼입니다.

OpenStack은 VM을 중심으로 한 IaaS(Infrastructure as a Service) 플랫폼으로, 서버, 스토리지, 네트워크 등의 인프라 자원을 가상화하여 사용자가 필요한 만큼 서비스 형태로 제공합니다.

많은 기업들이 자체 데이터센터에 클라우드 환경을 구축할 때 OpenStack을 활용하고 있습니다. 처음부터 클라우드 서비스를 개발하는 것보다는 대부분 OpenStack을 기반으로 클라우드 플랫폼을 구축한다고 봐도 과언이 아닙니다.

이제 OpenStack 위에 구축된 클라우드 환경과 Kubernetes 간에 발생한 문제 상황을 통해 두 시스템의 관계를 자세히 살펴보겠습니다.

## 문제 상황

### fsGroup이란?

fsGroup은 Kubernetes 환경에서 컨테이너가 권한이 없는 볼륨에 접근할 수 있도록 하는 보안 설정입니다. Pod의 보안 컨텍스트(SecurityContext)의 일부로 작동합니다.

SecurityContext에 대한 자세한 내용은 [Kubernetes 공식 문서](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)를 참고해주세요.

다음 예시로 동작 원리를 설명해드리겠습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  volumes:
  - name: sec-ctx-vol
    emptyDir: {}
  containers:
  - name: sec-ctx-demo
    image: busybox:1.28
    command: [ "sh", "-c", "sleep 1h" ]
    volumeMounts:
    - name: sec-ctx-vol
      mountPath: /data/demo
    securityContext:
      allowPrivilegeEscalation: false
```

위 설정에서 `sec-ctx-demo` 컨테이너의 모든 프로세스는:
- **uid**: 1000 (runAsUser)
- **gid**: 3000 (runAsGroup)

으로 실행됩니다. 

마운트된 볼륨 `/data/demo`과 그 안의 파일들은 모두 fsGroup으로 지정한 GID 2000으로 소유주가 설정됩니다. 또한 uid 1000 사용자도 이 2000 그룹에 속하게 되어, 컨테이너 내의 모든 프로세스가 해당 볼륨에 접근할 수 있게 됩니다.

```bash
drwxrwsrwx 2 root 2000 4096 Jun  6 20:08 demo
```

이를 통해 Kubernetes는 최소 권한 원칙에 따라 필요한 볼륨에만 Pod의 접근을 허용하고 관리합니다.

### fsGroup 설정이 적용되지 않는 문제

문제는 fsGroup 설정이 실제 볼륨에 제대로 적용되지 않는다는 점이었습니다.

현재 저는 OpenStack 기반 프라이빗 클라우드에서 Kubernetes를 운영하고 있습니다. Kubernetes에서는 **CSI(Container Storage Interface)**라는 스토리지 관리 표준 인터페이스를 제공하며, 그 뒤에는 CSI Driver라는 실제 구현체가 있어 Kubernetes의 스토리지 요청을 받아 인프라 레벨의 작업을 수행합니다.

OpenStack은 Kubernetes에서 사용할 수 있는 Cinder CSI Driver를 제공합니다. 이 드라이버는 요청을 받으면 OpenStack Cinder API를 호출하여 실제 블록 스토리지를 생성하고, 이를 Kubernetes의 PV(Persistent Volume)로 마운트하여 Pod에서 사용할 수 있게 합니다.

다음은 Cinder CSI Driver를 사용하는 StorageClass의 YAML 설정입니다:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: cinder-csi
provisioner: cinder.csi.openstack.org
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  type: "General SSD"
```

문제는 바로 여기서 발생했습니다. 이 StorageClass로 앞서 보여드린 Pod를 생성했을 때 다음과 같은 오류가 발생했습니다:

**Permission Denied**

초기화 과정에서 해당 볼륨에 접근하는 프로세스가 있다면 Pod 자체가 제대로 생성되지 않아 컨테이너 내부로도 접근이 불가능해집니다. 따라서 실제 볼륨 상태를 확인하려면 볼륨이 위치한 Worker Node로 직접 가서 문제를 진단해야 합니다.

**핵심 문제**: fsGroup으로 마운트된 볼륨의 그룹이 변경되어야 하는데 그대로 유지되는 현상
(예: fsGroup을 3000으로 설정해도 마운트된 디렉토리의 소유주가 여전히 root로 남아있음)

## 해결 과정

실제 Worker Node의 볼륨 생성 위치인 `/var/lib/kubelet/...`에서 볼륨 권한을 조회해보니, 디렉토리의 GID가 root 그대로 남아있었습니다. fsGroup을 2000으로 지정했음에도 불구하고 말입니다.

```bash
drwxr-xr-x 2 root root 4096 Jun  6 20:08 demo
```

여러 시행착오와 검색을 통해 마침내 관련 Github Issue를 발견할 수 있었습니다:

https://github.com/kubernetes/cloud-provider-openstack/issues/1362

## 해결 방법

결론적으로, Cinder CSI Driver 1.21 버전에서 fsGroup이 정상 작동하게 하려면 다음과 같이 설정해야 합니다:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: cinder-csi
provisioner: cinder.csi.openstack.org
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  type: "General SSD"
  fsType: "xfs"
```

**핵심은 `fsType` 파라미터 추가**입니다. 파일시스템 유형을 반드시 xfs로 할 필요는 없으며, ext4 등 다른 파일시스템으로도 설정 가능합니다. 소스 코드에서 fsType이 지정되어야만 fsGroup이 동작하도록 로직이 구현되어 있어 이런 문제가 발생했습니다.

이 조치를 적용한 후 Deployment를 다시 배포하니 정상적으로 동작하는 것을 확인할 수 있었습니다.

참고로 현재 Cinder CSI Driver는 1.33.1 버전이며, 위 이슈는 이미 해결된 상태입니다.

## 마무리

CSI는 Kubernetes에서 어떤 CSI Driver를 사용하더라도 일관된 형식으로 스토리지를 관리할 수 있게 해주는 편리한 인터페이스입니다. 하지만 이번 경험처럼 구현체에서 문제가 발생할 수 있기 때문에, Kubernetes뿐만 아니라 인프라 레벨에 대한 이해도 함께 갖추는 것이 중요하다고 생각합니다.

이런 문제들은 종종 버전별 이슈나 구현체의 세부 사항에서 비롯되므로, 공식 문서와 커뮤니티 이슈를 꾸준히 확인하는 것이 도움이 됩니다.