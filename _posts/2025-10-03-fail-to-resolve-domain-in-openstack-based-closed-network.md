---
layout: single
title: "Alpine 기반 컨테이너의 Kubernetes DNS 해석 실패 트러블슈팅"
date: 2025-10-03 14:30:00 +0900
categories: infrastructure
tags: [kubernetes, alpine, dns, musl, coredns, troubleshooting]
excerpt: "폐쇄망 Kubernetes 환경에서 Alpine 기반 컨테이너의 외부 도메인 DNS 해석 실패 문제를 분석하고 해결한 과정을 공유합니다."
---

## 문제 상황

Openstack 기반의 폐쇄망 클라우드 환경에서 DNS 해석 실패 문제가 발생했습니다.

**환경 구성**
- Managed Service 기반의 멀티 클러스터 Kubernetes 환경 (EKS와 유사)
- 폐쇄망 환경으로 내부 DNS 서버를 통해 클러스터 간 통신
- CoreDNS의 `forward` 설정이 내부 DNS 서버를 지향

**문제 증상**

한 클러스터의 파드에서 다른 클러스터로 요청을 보낼 때 DNS 해석이 실패했습니다. 문제가 되는 파드에서 `nslookup`을 실행한 결과:
- 외부 DNS 해석: 실패
- Kubernetes 내부 DNS 해석: 정상

파드의 `/etc/resolv.conf` 설정은 다음과 같았습니다:

```bash
search  example-namespace.svc.cluster.local svc.cluster.local cluster.local openstacklocal
nameserver 10.xxx.x.xx  # CoreDNS IP
options ndots:5
```

외부 도메인으로 `nslookup`을 실행하면 `server can't find openstacklocal: NXDOMAIN` 에러가 발생하며 해석에 실패했습니다.

## 원인 분석

이 문제는 이미 커뮤니티에 알려진 이슈였습니다:
- [k3s #6132](https://github.com/k3s-io/k3s/issues/6132)
- [kubernetes #112135](https://github.com/kubernetes/kubernetes/issues/112135)

**핵심 원인: musl libc의 DNS 처리 방식**

Alpine Linux는 경량화를 위해 `glibc` 대신 `musl libc`를 사용합니다. 두 라이브러리의 search domain 처리 방식이 다릅니다:

- **musl libc (Alpine)**: `openstacklocal` 도메인에서 `NXDOMAIN`을 받으면 즉시 검색을 중단하고 에러 반환
- **glibc (일반 Linux)**: `openstacklocal`이 존재하지 않아도 원본 도메인을 한 번 더 조회하여 성공

결론적으로 `/etc/resolv.conf`의 search 리스트에서 `openstacklocal`을 제거해야 했습니다.

## 해결 방법 1: dnsConfig 직접 설정

가장 직접적인 방법은 Deployment에서 `dnsConfig`와 `dnsPolicy`를 설정하는 것입니다.

```yaml
# spec.template.spec 하위에 추가
dnsConfig:
  nameservers: 
    - 10.xxx.x.xx  # CoreDNS IP
  searches:
    - example-namespace.svc.cluster.local
    - svc.cluster.local
    - cluster.local
  options:
    - name: ndots
      value: "5"
dnsPolicy: None
```

**주의사항: dnsPolicy를 반드시 None으로 설정**

`dnsPolicy`의 기본값은 `ClusterFirst`인데, 이 경우 파드의 search 도메인을 검색한 후 노드의 `/etc/resolv.conf`에 있는 search 도메인도 추가로 검색합니다. 노드에는 여전히 `openstacklocal`이 남아있어 같은 문제가 발생합니다.

`dnsPolicy: None`으로 설정하면 파드의 search만 검색한 후 바로 FQDN을 조회합니다.

**한계점**
- Alpine 기반 이미지를 모두 식별해야 함
- 네임스페이스마다 설정을 수정해야 함
- 클러스터마다 CoreDNS IP가 다르면 일일이 변경 필요
- 확장성이 떨어짐

## 해결 방법 2: kubelet 설정 변경

더 근본적인 해결책은 노드의 kubelet 설정을 통해 전역적으로 관리하는 것입니다.

**파드의 /etc/resolv.conf 생성 과정**

```bash
Pod 생성 요청 (namespace: production)
    ↓
kubelet DNS 생성기 동작
    ↓
1단계: 클러스터 search 생성
  - production.svc.cluster.local
  - svc.cluster.local
  - cluster.local
    ↓
2단계: 노드 search 추가 ← 이 부분을 kubelet으로 제어
  - openstacklocal
  - internal.company.com
    ↓
최종 search:
  production.svc.cluster.local svc.cluster.local cluster.local openstacklocal internal.company.com
```

**kubelet --resolv-conf 파라미터 활용**

kubelet을 systemd로 시작할 때 `--resolv-conf` 파라미터로 참조할 resolv.conf 파일을 지정할 수 있습니다.

1. `openstacklocal`이 없는 별도의 resolv.conf 파일 생성 (예: `/etc/resolv-k8s.conf`)
2. kubelet 설정에서 해당 파일을 참조하도록 변경
3. cloud-init 스크립트에 이 설정을 추가하여 노드 생성 시 자동 적용

이 방법을 사용하면 노드의 기본 `/etc/resolv.conf`는 그대로 유지하면서, 파드에만 수정된 DNS 설정을 적용할 수 있습니다.

## 노드의 openstacklocal은 왜 필요한가?

"노드의 `/etc/resolv.conf`에서 직접 `openstacklocal`을 제거하면 안 될까?"라는 의문이 들 수 있습니다.

하지만 이는 불가능한 옵션입니다. 이유는 **Cluster Autoscaling** 때문입니다.

- 현재 클라우드는 Openstack 기반으로 구성
- Pod 레벨의 HPA를 넘어 워커 노드 자체의 확장을 위해 Cluster Autoscaling 사용
- Openstack 환경에서 노드들은 `openstacklocal` 도메인을 통해 서로를 인식하고 넘버링
- 이 도메인이 없으면 Cluster Autoscaling이 정상 동작하지 않음

따라서 kubelet 설정을 통한 접근은 **노드 레벨의 오토스케일링은 유지하면서 파드 레벨의 DNS 문제만 해결**할 수 있는 최적의 방법이었습니다.

## 해결 방법 3: Kyverno를 통한 정책 관리

또 다른 대안으로 Kyverno를 활용한 클러스터 전역 정책 관리도 고려했습니다.

**Kyverno란?**

Kyverno는 CNCF 프로젝트로, Kubernetes의 Mutating/Validating Webhook을 선언적으로 구현한 오픈소스입니다. 코드 개발 없이 YAML만으로 클러스터 전역 정책을 설정할 수 있습니다.

**Kubernetes 리소스 생성 흐름**

```
kubectl apply
    ↓
API Server 수신
    ↓
Authentication (인증)
    ↓
Authorization (인가)
    ↓
┌─────────────────────────────┐
│  Admission Control 단계     │
│  (Kyverno가 여기서 동작)    │
│                             │
│  → Mutating Webhooks        │  ← Kyverno가 리소스 변형
│  → Validating Webhooks      │  ← Kyverno가 검증
└─────────────────────────────┘
    ↓
Validation (스키마 검증)
    ↓
etcd에 저장
    ↓
Controller가 배포 시작
```

**Kyverno 설정 예시**

```yaml
# dnsConfig 적용 정책
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: set-dns-config
spec:
  rules:
    - name: enforce-dns-config
      match:
        resources:
          kinds:
            - Pod
      mutate:
        patchStrategicMerge:
          spec:
            dnsConfig:
              searches:
                - "{{request.object.metadata.namespace}}.svc.cluster.local"
                - svc.cluster.local
                - cluster.local
              options:
                - name: ndots
                  value: "5"
```

```yaml
# dnsPolicy 적용 정책
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: force-dns-policy-none
spec:
  rules:
    - name: set-dns-policy-none
      match:
        resources:
          kinds:
            - Pod
      mutate:
        patchStrategicMerge:
          spec:
            dnsPolicy: None
```

**Kyverno의 장점**
- 노드별 설정 없이 클러스터 단위로 관리
- YAML을 통한 선언적 관리
- 버전 관리 및 배포 자동화 용이

## 마치며

Alpine 기반 컨테이너의 DNS 해석 문제는 `musl libc`의 특성에서 비롯된 것으로, 다음 세 가지 해결 방법이 있습니다:

1. **dnsConfig 직접 설정**: 빠르지만 확장성 낮음
2. **kubelet 설정 변경**: 노드 레벨 관리, 오토스케일링과 호환
3. **Kyverno 정책 적용**: 선언적 관리, 유지보수 용이

각 방법은 환경과 요구사항에 따라 선택할 수 있으며, 저희는 Cluster Autoscaling을 고려하여 **kubelet 설정 변경 방식**을 채택했습니다. `Kyverno`가 좀 더 편리한 해결책이기는 하지만, 오픈소스이고 검토가 부족하다고 생각해 적용은 보류한 상태입니다.

이 글이 폐쇄망 환경에서 멀티 클러스터를 운영하시는 분들께 도움이 되기를 바랍니다.