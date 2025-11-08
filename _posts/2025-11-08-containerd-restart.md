---
layout: single
title: "containerd를 재시작하면 Pod가 재시작될까?"
date: 2025-11-08 09:00:00 +0900
categories: kubernetes
tags: [kubernetes, system, containerd]
excerpt: "containerd를 kubernetes에서 재시작해도 Pod가 중단되지 않는 이유를 알아보았습니다."
---

### 발단

[OpenSearch의 설정(memlock) 문제](https://dongjangoon.github.io/infrastructure/2025/09/15/opensearch-ulimit-troubleshooting/)를 해결하기 위해 워커 노드에서 containerd의 systemd에 특정 설정을 추가한 뒤, 그 적용을 위해 containerd를 재시작해야 하는 경우가 있었습니다. 

이 작업의 처음 예상 결과는 Pod가 재시작되어 서비스에 순단이 있을 수 있다고 생각했습니다. 

작업 시간대는 개발자들이 사용하지 않는 시간이어서 실행 가능했지만, 이후 해당 워커 노드에 떠있는 Pod들이 재시작되었는가를 검토해봤을 때 결과는 예상과 달리 재시작되지 않았습니다. 

왜 그런지 알아보기 위해 containerd, CRI에 대해서 알아봤습니다.

## containerd의 아키텍처

containerd는 단일 데몬으로 모든 컨테이너를 직접 관리하지 않습니다. 대신 계층적 구조를 통해 컨테이너를 관리합니다.
```
containerd (데몬) → containerd-shim (프로세스) → runc (OCI 런타임) → container process
```

각 컨테이너마다 독립적인 `containerd-shim` 프로세스가 생성되며, 이 shim이 실제 컨테이너 프로세스의 부모 프로세스 역할을 수행합니다.

### containerd-shim의 역할

containerd-shim은 다음과 같은 중요한 역할을 담당합니다:

1. **STDIO 관리**: 컨테이너의 표준 입출력 스트림 유지
2. **시그널 전달**: 컨테이너에 SIGTERM, SIGKILL 등의 시그널 전달
3. **종료 상태 보고**: 컨테이너가 종료되면 exit code를 containerd에 보고
4. **좀비 프로세스 방지**: 컨테이너 프로세스의 reaping 담당

가장 중요한 점은 containerd-shim이 **containerd 데몬과 독립적으로 동작**한다는 것입니다.

## containerd 재시작 시 동작 원리

containerd가 컨테이너를 시작하는 과정을 살펴보면:

1. containerd가 containerd-shim 프로세스를 fork하여 생성
2. containerd-shim이 runc를 호출하여 컨테이너 생성
3. runc가 컨테이너 프로세스를 시작하고 종료
4. containerd-shim이 컨테이너 프로세스의 부모 프로세스로 남음

이후 프로세스 트리는 다음과 같은 형태가 됩니다:
```bash
systemd
  └─ containerd-shim
       └─ container process
```

containerd 데몬이 재시작되면:

1. containerd 데몬 프로세스만 종료되고 재시작
2. containerd-shim 프로세스들은 고아(orphan) 프로세스가 되어 systemd의 자식으로 재부모화(reparenting)
3. 각 컨테이너 프로세스는 자신의 shim 부모 아래서 정상 동작 유지
4. containerd가 재시작 완료 후 `/run/containerd` 등의 상태 정보를 읽어 기존 컨테이너들과 재연결

### 프로세스 트리 변화 확인

실제로 프로세스 트리를 확인해보면 이 동작을 관찰할 수 있습니다:
```bash
# containerd 실행 중
pstree -p | grep containerd
# systemd(1)───containerd(1234)─┬─containerd-shim(5678)───nginx(9012)
#                                └─containerd-shim(5679)───redis(9013)

# containerd 재시작 후
pstree -p | grep containerd
# systemd(1)───containerd(1235)  (새로운 PID)
# systemd(1)─┬─containerd-shim(5678)───nginx(9012)  (기존 shim, systemd의 자식)
#            └─containerd-shim(5679)───redis(9013)
```

## Kubernetes와 CRI의 관계

Kubernetes에서 컨테이너 런타임은 CRI (Container Runtime Interface)를 통해 통신합니다.
```
kubelet ←[CRI gRPC]→ containerd ←→ containerd-shim ←→ container
```

### CRI (Container Runtime Interface)

CRI는 Kubernetes가 다양한 컨테이너 런타임을 지원하기 위해 만든 표준 인터페이스입니다. kubelet은 CRI 인터페이스만 알면 되고, 실제 구현체는 교체 가능합니다.

**주요 CRI 구현체:**

- **containerd**: CNCF 프로젝트, 현재 가장 널리 사용됨
- **CRI-O**: Red Hat 주도, OpenShift 기본 런타임
- **Docker Engine**: dockershim을 통해 사용 (Kubernetes 1.24에서 제거됨)

### Kubernetes에서 containerd 재시작의 영향

containerd를 재시작하면:

1. kubelet과 containerd 간 CRI 연결이 일시적으로 끊김
2. 컨테이너 프로세스는 shim 아래서 계속 실행
3. containerd 재시작 완료 후 kubelet이 재연결하여 정상 동작

**재시작 중 제한사항:**

- 새로운 Pod 생성 불가
- 컨테이너 이미지 pull 불가
- `kubectl exec`, `kubectl logs` 등 명령 실행 불가
- 컨테이너 로그 수집 일시 중단

하지만 기존에 실행 중이던 컨테이너의 애플리케이션은 영향받지 않습니다.

## kubelet의 역할과 영향

비교를 위해 kubelet이 재시작되면 어떻게 되는지도 살펴보겠습니다.

### kubelet의 역할

kubelet은 각 노드에서 실행되는 Kubernetes 에이전트로:

1. **Pod 관리**: API 서버로부터 Pod 스펙을 받아 실행
2. **상태 보고**: Pod/Node 상태를 API 서버에 지속적으로 보고
3. **헬스체크**: liveness/readiness probe 수행
4. **리소스 관리**: CPU/Memory 사용량 모니터링

### kubelet 재시작의 영향
```bash
# kubelet 정지
systemctl stop kubelet

# 컨테이너는 계속 실행되지만
kubectl get pods  # 여전히 Running 상태

# 약 40초 후 노드 상태 변경
kubectl get nodes
# NAME       STATUS     ROLES    AGE   VERSION
# worker-1   NotReady   <none>   10d   v1.28.0

# 제한사항
# - 새로운 Pod 스케줄링 불가
# - kubectl exec/logs 실행 불가
# - liveness/readiness probe 동작 중단
# - 약 5분 후 Pod Eviction 시작 (다른 노드로 재스케줄링)
```

## 실제 운영 시나리오

### containerd 무중단 업그레이드

이러한 설계 덕분에 프로덕션 환경에서도 containerd를 무중단으로 업그레이드할 수 있습니다. 발단에서 언급한 opensearch 작업 역시도 아래처럼 노드 cordon 작업 과정이 먼저 선행되었어야 하는 부분입니다.

```bash
# 1. 노드를 cordon하여 새로운 Pod 스케줄링 방지
kubectl cordon worker-1

# 2. containerd 업그레이드
apt-get update && apt-get install -y containerd

# 3. containerd 재시작
systemctl restart containerd

# 4. 동작 확인 후 uncordon
kubectl get pods -o wide | grep worker-1  # Pod 상태 확인
kubectl uncordon worker-1
```

### 데몬과 프로세스 관리의 이해

containerd를 "관리자(Manager)" 또는 "조정자(Coordinator)"로 생각하면 이해하기 쉽습니다. Kubernetes Operator 패턴과 유사하게:
```
Operator 다운 → 관리하던 리소스는 계속 동작 → Operator 재시작 → 다시 관리 재개
containerd 다운 → shim과 컨테이너는 계속 동작 → containerd 재시작 → 다시 관리 재개
```

**전통적인 방식 (Docker 초기):**
```
dockerd → container process
```
dockerd가 죽으면 모든 컨테이너가 함께 종료되었습니다.

**현대적인 방식 (containerd + shim):**
```
containerd → containerd-shim → container process
(재시작)      (유지됨)
```
containerd가 죽어도 컨테이너는 계속 실행됩니다.

## 정리

containerd를 재시작해도 Pod가 재시작되지 않는 이유는:

1. containerd-shim이라는 중간 프로세스가 각 컨테이너를 직접 관리
2. containerd는 관리자 역할만 수행하며, 실제 컨테이너 프로세스와 직접적인 부모-자식 관계가 아님
3. containerd 재시작 시 shim과 컨테이너는 독립적으로 계속 실행
4. containerd가 재시작되면 기존 상태를 복구하여 관리 재개

이러한 설계는 컨테이너 런타임의 무중단 업그레이드를 가능하게 하며, 프로덕션 환경에서 안정적인 운영을 지원합니다.

## 참고 자료

- [Kubernetes CRI (Container Runtime Interface)](https://kubernetes.io/docs/concepts/architecture/cri/)
- [containerd GitHub Repository](https://github.com/containerd/containerd)
- [Kubernetes Components - kubelet](https://kubernetes.io/docs/concepts/overview/components/#kubelet)