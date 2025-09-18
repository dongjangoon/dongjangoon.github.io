---
layout: single
title: "OpenSearch Kubernetes memlock 트러블슈팅"
date: 2025-09-15 11:01:00 +0900
categories: infrastructure
tags: [opensearch, kubernetes, memlock, containerd, troubleshooting]
excerpt: "Kubernetes 환경에서 OpenSearch 실행 시 발생한 JVM 메모리 잠금 오류 해결 과정을 공유합니다."
---

## 들어가며

### OpenSearch 소개

OpenSearch는 Apache 2.0 라이선스 하에 개발된 오픈소스 검색 및 분석 엔진입니다. 원래 Elasticsearch 7.10.2 버전에서 포크되어 AWS가 주도하여 개발하고 있으며, 로그 분석, 실시간 모니터링, 보안 분석 등 다양한 용도로 활용됩니다.

특히 Kubernetes 환경에서 ELK 스택의 대안으로 많이 사용되고 있으며, 검색 성능 최적화를 위해 JVM 힙 메모리를 물리 메모리에 고정하는 메모리 잠금(memory lock) 기능을 제공합니다.

이번 포스트에서는 Kubernetes 파드 환경에서 OpenSearch를 실행할 때 발생한 메모리 잠금 오류와 이를 해결한 과정을 자세히 살펴보겠습니다.

## 문제 상황

### 메모리 잠금(memlock)이란?

메모리 잠금은 JVM 힙 메모리가 디스크로 스왑(swap)되는 것을 방지하는 기능입니다. OpenSearch에서는 `bootstrap.memory_lock: true` 설정을 통해 활성화할 수 있습니다.

메모리 잠금의 장점:
- **일관된 성능**: 메모리가 스왑되지 않아 안정적인 응답시간 보장
- **고성능 유지**: 디스크 I/O 없이 메모리 접근만으로 빠른 처리
- **예측 가능한 지연시간**: 스왑으로 인한 급격한 성능 저하 방지

하지만 이 기능을 사용하려면 시스템에서 `IPC_LOCK`, `SYS_RESOURCE` capability와 적절한 `RLIMIT_MEMLOCK` 설정이 필요합니다.

### memlock 오류 발생

Kubernetes 환경에서 OpenSearch 파드를 실행할 때 다음과 같은 오류가 발생했습니다:

```
WARNING: A terminally deprecated method in java.lang.System has been called
WARNING: System::setSecurityManager has been called by org.opensearch.bootstrap.OpenSearch
WARNING: Please consider reporting this to the maintainers of org.opensearch.bootstrap.OpenSearch
WARNING: System::setSecurityManager will be removed in a future release
[sxa-sts-os-0] Unable to lock JVM Memory: error=12, reason=Cannot allocate memory
```

**핵심 문제**: OpenSearch가 JVM 메모리를 잠그려고 시도했지만 시스템 권한 부족으로 실패

이 오류로 인해 OpenSearch 파드가 정상적으로 기동되지 않았습니다. 파드 내부에서 `ulimit -l` 명령어로 확인해보니 메모리 잠금 제한이 매우 낮게 설정되어 있었습니다.

```bash
$ ulimit -l
65536  # 64KB로 제한됨
```

## 해결 과정

초기에는 Kubernetes 네이티브한 방법들을 시도해보았습니다.

### 시도해본 방법들

**1. SecurityContext 설정**
```yaml
securityContext:
  capabilities:
    add:
      - IPC_LOCK
      - SYS_RESOURCE
```

**2. Init Container 활용**
```yaml
initContainers:
- name: configure-sysctl
  securityContext:
    privileged: true
  command: ['sh', '-c', 'ulimit -l unlimited']
```

**3. 메모리 잠금 비활성화**
```yaml
env:
- name: bootstrap.memory_lock
  value: "false"
```

하지만 첫 번째와 두 번째 방법은 클러스터의 보안 정책이나 권한 제약으로 인해 실패했고, 세 번째 방법은 임시방편일 뿐 성능상 바람직하지 않았습니다.

### 근본적 해결 방법 발견

여러 시행착오 끝에 containerd의 systemd 서비스 설정을 수정하는 방법을 발견했습니다.

## 해결 방법

결론적으로, containerd systemd 서비스에 메모리 잠금 제한을 해제하는 설정을 추가하는 것이 가장 효과적인 해결책이었습니다.

### containerd 서비스 설정 수정

```bash
# containerd 서비스 오버라이드 파일 생성
sudo systemctl edit containerd
```

또는 직접 파일을 생성:

```bash
sudo vi /etc/systemd/system/containerd.service.d/override.conf
```

다음 내용을 추가:

```ini
[Service]
LimitMEMLOCK=infinity
```

### 시스템 적용

```bash
# systemd 데몬 리로드
sudo systemctl daemon-reload

# containerd 서비스 재시작
sudo systemctl restart containerd
```

### 검증

파드 재시작 후 메모리 잠금 제한 확인:

```bash
$ kubectl exec -it opensearch-pod -- ulimit -l
unlimited  # 성공!
```

OpenSearch 로그에서도 메모리 잠금 관련 오류가 사라지고 정상적으로 기동되는 것을 확인할 수 있었습니다.

```
[opensearch-node] loaded [], sites []
[opensearch-node] initialized
[opensearch-node] starting ...
[opensearch-node] started
```

## 성능 비교

### 메모리 잠금 활성화 vs 비활성화

| 구분 | memory_lock: true | memory_lock: false |
|------|-------------------|-------------------|
| 쿼리 응답시간 | 10-50ms (일관됨) | 10ms-2000ms+ (편차 큼) |
| 인덱싱 성능 | 안정적 | 간헐적 급격한 저하 |
| 메모리 사용 | 물리 메모리 고정 | 스왑 가능 |
| 시스템 안정성 | 예측 가능 | 메모리 부족 시 불안정 |

실제 운영 환경에서는 메모리 잠금을 활성화하는 것이 성능과 안정성 측면에서 훨씬 유리합니다.

### OpenSearch 최종 설정

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-config
data:
  opensearch.yml: |
    cluster.name: opensearch-cluster
    node.name: opensearch-node
    bootstrap.memory_lock: true  # 메모리 잠금 활성화
    discovery.type: single-node
    
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opensearch
spec:
  template:
    spec:
      containers:
      - name: opensearch
        image: opensearchproject/opensearch:2.10.0
        env:
        - name: "OPENSEARCH_JAVA_OPTS"
          value: "-Xms2g -Xmx2g"
        resources:
          limits:
            memory: "4Gi"
          requests:
            memory: "4Gi"
```

## 마무리

처음에는 워커 노드의 `/etc/security/limits.conf` 수정으로 이 현상을 해결하려고 했었지만 불가능했습니다. limits.conf는 새로운 사용자 세션에만 적용되며, 이미 실행 중인 systemd 서비스(containerd)나 파드에는 영향을 주지 않습니다. 따라서 containerd 서비스 자체의 systemd 설정을 수정하는 것이 필요했습니다. (참고로 워커 노드의 OS는 Ubuntu 22.04였습니다.)

또한 OpenSearch 같은 검색 엔진을 운영할 때는 다음 두 가지 시스템 설정이 모두 필요함을 확인했습니다:
- **vm.max_map_count**: 메모리 맵 영역 제한 해제
- **LimitMEMLOCK**: 메모리 잠금 제한 해제

Kubernetes의 SecurityContext나 Init Container 등의 방법들이 이론적으로는 가능하지만, 실제 운영 환경에서는 보안 정책이나 권한 제약으로 인해 작동하지 않는 경우가 많습니다. 반면 systemd 서비스 설정은 시스템 레벨에서 모든 컨테이너에 일관되게 적용되어 더욱 안정적입니다.

특히 OpenSearch나 Elasticsearch 같은 메모리 집약적인 애플리케이션을 운영할 때는 이런 시스템 레벨의 최적화가 성능에 큰 영향을 미칠 수 있습니다. 애플리케이션 레벨의 설정뿐만 아니라 인프라 레벨에서의 튜닝도 함께 고려하는 것이 중요하다고 생각합니다.

### 참고 자료

- [Kubernetes Security Context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [containerd systemd configuration](https://github.com/containerd/containerd/blob/main/docs/ops.md#systemd)