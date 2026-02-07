---
layout: single
title: "Kubernetes 리소스 생성 흐름: kubectl apply부터 컨테이너 실행까지"
date: 2026-02-07 10:00:00 +0900
categories: kubernetes
tags: [kubernetes, api-server, etcd, scheduler, kubelet, controller, informer, admission-controller, cri, cni]
excerpt: "kubectl apply를 실행하면 내부적으로 어떤 일이 벌어질까? API Server의 인증/인가/Admission 체인부터 Controller의 Informer 아키텍처, Scheduler의 노드 선택, kubelet의 CRI/CNI/CSI 호출까지 전체 흐름을 깊이 있게 살펴봅니다."
---

## 들어가며

`kubectl apply -f deployment.yaml`

Kubernetes를 사용해본 분이라면 수없이 입력했을 명령어입니다. 그런데 이 한 줄이 실행되는 순간 클러스터 내부에서는 정확히 어떤 일이 벌어질까요?

"Deployment를 만들면 ReplicaSet이 생기고, ReplicaSet이 Pod를 만들고..." 정도는 알고 있지만, API Server 내부에서 요청이 어떤 체인을 거치는지, Controller가 어떻게 변경을 감지하는지, Scheduler가 어떤 알고리즘으로 노드를 선택하는지를 정확히 설명할 수 있는 분은 많지 않을 겁니다.

이 글에서는 Kubernetes 공식 문서와 소스 코드 기반으로, 리소스 생성의 전체 흐름을 각 컴포넌트의 내부 동작까지 파고들어 살펴보겠습니다.

## 전체 아키텍처 개요

먼저 Kubernetes 클러스터의 전체 구조를 보겠습니다. 리소스 생성 흐름의 각 단계가 어느 컴포넌트에서 일어나는지 파악하는 데 도움이 됩니다.

```
┌──────────────────────────────────────────────────────────────┐
│                       Control Plane                          │
│                                                              │
│  ┌──────────┐    ┌────────────┐    ┌───────────────────┐     │
│  │ kubectl   │──▶│ API Server │──▶│       etcd         │     │
│  │ (client)  │   │ (kube-     │   │ (Consistent KV     │     │
│  └──────────┘   │  apiserver) │   │  Store)             │     │
│                  └──────┬─────┘   └───────────────────┘     │
│                         │                                    │
│             ┌───────────┼───────────┐                        │
│             ▼           ▼           ▼                        │
│   ┌──────────────┐ ┌──────────┐ ┌───────────────┐           │
│   │kube-scheduler│ │  kube-   │ │  Admission     │           │
│   │              │ │controller│ │  Controllers   │           │
│   │              │ │ -manager │ │  (Webhook)     │           │
│   └──────────────┘ └──────────┘ └───────────────┘           │
└──────────────────────────────────────────────────────────────┘
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│    Node 1     │ │    Node 2     │ │    Node 3     │
│ ┌───────────┐ │ │ ┌───────────┐ │ │ ┌───────────┐ │
│ │  kubelet  │ │ │ │  kubelet  │ │ │ │  kubelet  │ │
│ ├───────────┤ │ │ ├───────────┤ │ │ ├───────────┤ │
│ │kube-proxy │ │ │ │kube-proxy │ │ │ │kube-proxy │ │
│ ├───────────┤ │ │ ├───────────┤ │ │ ├───────────┤ │
│ │ container │ │ │ │ container │ │ │ │ container │ │
│ │  runtime  │ │ │ │  runtime  │ │ │ │  runtime  │ │
│ └───────────┘ │ │ └───────────┘ │ │ └───────────┘ │
└───────────────┘ └───────────────┘ └───────────────┘
```

리소스 하나가 생성되기까지 크게 **5단계**를 거칩니다.

1. **클라이언트 → API Server**: HTTP 요청 전송
2. **API Server 내부 처리**: 인증 → 인가 → Admission → etcd 저장
3. **Controller Manager**: Desired State 실현 (Deployment → ReplicaSet → Pod)
4. **Scheduler**: 노드 배치 결정
5. **kubelet**: 실제 컨테이너 실행

각 단계를 하나씩 깊이 살펴보겠습니다.

## Phase 1: 클라이언트에서 API Server로

### kubectl의 요청 생성

`kubectl apply -f deployment.yaml`을 실행하면, kubectl은 내부적으로 다음 순서를 거칩니다.

```
kubectl → kubeconfig 읽기 → 인증 정보 로드 → YAML→JSON 변환 → REST API 호출
```

kubectl은 `~/.kube/config`(kubeconfig)에서 cluster endpoint, 인증서, context 정보를 읽고, YAML 매니페스트를 JSON으로 변환한 뒤 API Server에 HTTP 요청을 전송합니다.

실제 API 호출을 보면 다음과 같습니다.

```
POST /apis/apps/v1/namespaces/default/deployments
Content-Type: application/json
Authorization: Bearer <token>

{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": "nginx-deploy" },
  "spec": { ... }
}
```

핵심은 **모든 리소스 조작이 RESTful API**라는 점입니다. kubectl은 이 API의 CLI 클라이언트일 뿐이고, 같은 API를 client-go, Python client 등의 SDK로도 동일하게 호출할 수 있습니다. Kubernetes 대시보드, Terraform, ArgoCD도 모두 같은 API를 사용합니다.

### API 경로 구조

Kubernetes API는 그룹과 버전으로 체계적으로 조직되어 있습니다.

```
Core API (Legacy):     /api/v1/namespaces/{ns}/pods
Apps Group:            /apis/apps/v1/namespaces/{ns}/deployments
Batch Group:           /apis/batch/v1/namespaces/{ns}/jobs
Custom Resources:      /apis/{group}/{version}/namespaces/{ns}/{resource}
```

Pod, Service, ConfigMap 같은 핵심 리소스는 `/api/v1` 아래에 위치하고, Deployment, StatefulSet 등 이후에 추가된 리소스는 `/apis/{group}/{version}` 형태를 따릅니다. CRD(Custom Resource Definition)로 등록한 리소스도 동일한 패턴으로 노출됩니다.

kube-apiserver는 **API Discovery** 엔드포인트(`/apis`, `/api`)를 제공하여, 클라이언트가 등록된 모든 API 그룹/버전/리소스를 동적으로 발견할 수 있게 합니다.

## Phase 2: API Server 내부 처리 파이프라인

이 부분이 리소스 생성 흐름의 핵심입니다. API Server 내부에서 요청은 **정확히 아래 순서의 체인**을 통과합니다. 하나라도 실패하면 요청은 거부됩니다.

```
HTTP Request
    │
    ▼
┌──────────────────────────────────────┐
│  1. Authentication (인증)             │  ← "누구인가?"
│     - x509 Client Cert               │
│     - Bearer Token                   │
│     - OIDC                           │
│     - ServiceAccount Token           │
│     - Webhook Token Auth             │
├──────────────────────────────────────┤
│  2. Authorization (인가)              │  ← "할 수 있는가?"
│     - RBAC (가장 일반적)               │
│     - ABAC                           │
│     - Node Authorizer                │
│     - Webhook                        │
├──────────────────────────────────────┤
│  3. Mutating Admission Webhooks      │  ← "요청을 변환"
│     - 리소스 필드 주입/변경            │
│     - sidecar injection (Istio 등)   │
│     - default 값 설정                 │
├──────────────────────────────────────┤
│  4. Object Schema Validation         │  ← "스키마 유효성 검사"
│     - OpenAPI v3 schema 검증          │
│     - Required fields 확인            │
├──────────────────────────────────────┤
│  5. Validating Admission Webhooks    │  ← "정책 검증"
│     - OPA/Gatekeeper                 │
│     - 리소스 제약 조건 체크            │
│     - 변경 없이 승인/거부만            │
├──────────────────────────────────────┤
│  6. etcd Persistence                 │  ← "저장"
│     - Serialization (protobuf)       │
│     - Write to etcd                  │
└──────────────────────────────────────┘
```

### Authentication (인증)

API Server는 **여러 인증 모듈을 체인으로** 실행합니다. 하나라도 성공하면 인증이 완료되고, 모두 실패하면 `401 Unauthorized`를 반환합니다.

```
Request → x509 체크 → 실패 → Bearer Token 체크 → 실패 → OIDC 체크 → 성공!
                                                              │
                                                              ▼
                                                   user: donghyun
                                                   groups: ["dev-team"]
```

인증 결과로 **UserInfo 객체**(username, UID, groups, extra)가 생성됩니다. 이 정보가 이후 인가 단계에 그대로 전달됩니다.

주요 인증 방식을 정리하면 다음과 같습니다.

| 방식 | 사용 시나리오 | 특징 |
|-----|------------|------|
| x509 Client Certificate | kubectl, 컴포넌트 간 통신 | CN이 username, O가 group으로 매핑 |
| Bearer Token | ServiceAccount, 외부 시스템 | JWT 형태, TokenReview API로 검증 |
| OIDC | 기업 환경 SSO 연동 | IdP에서 발급한 토큰 사용 |
| Webhook Token Auth | 커스텀 인증 시스템 | 외부 서비스에 인증 위임 |

### Authorization (인가) — RBAC 중심

인증된 사용자의 요청이 허용되는지 판단하는 단계입니다. 요청은 다음 **Attributes**로 분해됩니다.

| Attribute | 예시 |
|-----------|------|
| user | `donghyun` |
| group | `dev-team` |
| verb | `create` |
| resource | `deployments` |
| apiGroup | `apps` |
| namespace | `default` |

RBAC(Role-Based Access Control)이 가장 일반적인 인가 방식입니다. Role/ClusterRole에서 권한을 정의하고, RoleBinding/ClusterRoleBinding으로 사용자에게 연결합니다.

```yaml
# ClusterRole: 어떤 권한을 정의
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deployment-manager
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "create", "update", "delete"]
```

```yaml
# RoleBinding: 권한을 사용자에 연결
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deploy-binding
  namespace: default
subjects:
- kind: User
  name: donghyun
roleRef:
  kind: ClusterRole
  name: deployment-manager
```

RBAC authorizer는 모든 RoleBinding/ClusterRoleBinding을 **인메모리 캐시**에 보관하고 빠르게 매칭합니다. Node Authorizer는 kubelet이 자신의 노드에 스케줄링된 Pod만 접근할 수 있도록 제한하는 특수한 authorizer입니다.

### Admission Controllers — Mutating & Validating

인가까지 통과한 요청은 Admission Controller 체인을 거칩니다. 이 단계가 실무에서 보안 정책과 운영 규칙을 강제하는 핵심 메커니즘입니다.

두 종류의 Admission이 **순서대로** 실행됩니다.

```
Mutating Admission (순차 실행, 요청 변경 가능)
    │
    ▼
Object Schema Validation
    │
    ▼
Validating Admission (병렬 실행, 승인/거부만 가능)
```

**Mutating Admission**은 요청 오브젝트를 변경할 수 있습니다. 대표적인 예가 Istio의 sidecar injection입니다.

```
원본 Pod spec:                     Mutating Webhook 적용 후:
┌──────────────┐                   ┌──────────────────────┐
│ containers:  │                   │ containers:          │
│ - app: nginx │      ──────▶      │ - app: nginx         │
│              │                   │ - istio-proxy (주입) │
│              │                   │ initContainers:      │
│              │                   │ - istio-init (주입)  │
└──────────────┘                   └──────────────────────┘
```

사용자가 정의한 Pod spec에는 nginx 컨테이너 하나뿐이지만, Mutating Webhook이 istio-proxy sidecar와 init container를 자동으로 주입합니다. 사용자 입장에서는 코드 변경 없이 서비스 메시가 적용되는 것입니다.

**Validating Admission**은 요청을 변경하지 않고 승인 또는 거부만 합니다. OPA/Gatekeeper가 대표적입니다.

```
Pod spec에 resource limits 없음
    │
    ▼
Validating Webhook이 거부
    │
    ▼
403 Forbidden: "all containers must have resource limits"
```

규제가 강한 환경에서는 이 단계에서 보안 정책, 리소스 제한, 이미지 정책 등을 강제하는 것이 일반적입니다. 컨테이너 이미지가 승인된 레지스트리에서 온 것인지, resource limits가 설정되어 있는지, 특정 label이 존재하는지 등을 자동으로 검증할 수 있습니다.

### etcd 저장

모든 Admission을 통과하면, 오브젝트는 **protobuf로 직렬화**되어 etcd에 저장됩니다.

```
etcd key 구조:
/registry/{resource-type}/{namespace}/{name}

예시:
/registry/deployments/default/nginx-deploy
```

etcd 저장이 완료되면 API Server는 클라이언트에게 **201 Created** 응답을 반환합니다.

여기서 중요한 점은 **이 시점에 Pod는 아직 존재하지 않는다**는 것입니다. 단지 Deployment 오브젝트가 etcd에 기록된 것뿐입니다. 실제 Pod가 생성되고 컨테이너가 실행되기까지는 이후 단계의 컨트롤러들이 동작해야 합니다.

## Phase 3: Controller Manager — Desired State 실현

etcd에 Deployment가 저장되면 이제 Kubernetes의 핵심 철학인 **Declarative Model + Reconciliation Loop**가 작동합니다.

### Informer 아키텍처

모든 Controller는 **Informer**라는 공통 프레임워크를 사용하여 API Server의 변경 사항을 효율적으로 감지합니다. 이 구조를 이해하는 것이 Kubernetes 내부를 이해하는 핵심입니다.

```
┌───────────────────────────────────────────────────────────────┐
│                Controller (e.g., Deployment Controller)        │
│                                                               │
│  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐   │
│  │  Reflector   │────▶│  DeltaFIFO   │────▶│   Indexer    │   │
│  │ (List&Watch) │     │  (Queue)     │     │ (Local Cache)│   │
│  └──────┬──────┘     └──────┬───────┘     └──────────────┘   │
│         │                    │                                │
│         │                    ▼                                │
│         │            ┌──────────────┐                         │
│         │            │    Event     │                         │
│         │            │   Handlers   │                         │
│         │            │ (Add/Update/ │                         │
│         │            │  Delete)     │                         │
│         │            └──────┬───────┘                         │
│         │                   │                                 │
│         │                   ▼                                 │
│         │            ┌──────────────┐                         │
│  API    │            │  Work Queue  │                         │
│  Server ◀────────────│ (Rate-limited│                         │
│         │            │  Retry Queue)│                         │
│         │            └──────┬───────┘                         │
│         │                   │                                 │
│         │                   ▼                                 │
│         ◀────────────┌──────────────┐                         │
│  (Write API calls)   │ Reconcile()  │                         │
│                      │ (핵심 로직)   │                         │
│                      └──────────────┘                         │
└───────────────────────────────────────────────────────────────┘
```

각 컴포넌트의 역할을 하나씩 보겠습니다.

**Reflector (List & Watch)**

API Server에 대해 `List`(초기 전체 목록)와 `Watch`(이후 변경 스트림)를 수행합니다. Watch는 HTTP chunked response 기반의 **스트리밍 연결**입니다.

```
GET /apis/apps/v1/namespaces/default/deployments?watch=true&resourceVersion=12345
---
{"type":"ADDED","object":{...}}
{"type":"MODIFIED","object":{...}}
```

여기서 **resourceVersion**이 핵심 역할을 합니다. etcd의 revision에 매핑되는 이 값은 Watch 연결이 끊겼다가 재연결될 때 이 버전부터 이벤트를 다시 받아 **데이터 손실을 방지**합니다.

**DeltaFIFO**

이벤트를 순서대로 큐에 쌓으면서 동일 오브젝트에 대한 중복 이벤트를 압축(deduplication)합니다. 예를 들어, 같은 오브젝트가 짧은 시간에 여러 번 업데이트되면 최종 상태만 처리합니다.

**Indexer (Local Cache)**

인메모리 캐시로, Controller가 매번 API Server에 GET 요청을 보내지 않고 로컬에서 빠르게 조회할 수 있게 합니다. 이것이 API Server의 부하를 극적으로 줄여주는 핵심 메커니즘입니다. Controller가 "현재 이 Deployment의 ReplicaSet이 몇 개인가?"를 확인할 때 API Server가 아닌 로컬 캐시에서 조회합니다.

**Work Queue**

Event Handler가 받은 이벤트를 Work Queue에 넣으면, 별도 워커 고루틴이 이를 꺼내 Reconcile 함수를 실행합니다. Rate-limiting과 재시도(exponential backoff) 로직이 내장되어 있어, Reconcile 실패 시 자동으로 재시도합니다.

### Deployment 생성 시 컨트롤러 체인

Deployment 하나가 생성되면 **3개의 컨트롤러가 연쇄적으로** 동작합니다. 각 컨트롤러는 자신이 Watch하는 리소스의 변경을 감지하고, 다음 단계의 리소스를 생성합니다.

```
Deployment Controller          ReplicaSet Controller         Scheduler
      │                              │                          │
      │ Watch: Deployment 생성 감지    │                          │
      ▼                              │                          │
 ReplicaSet 생성                      │                          │
 (API Server에 POST)                 │                          │
      │                              │                          │
      │                              ▼                          │
      │                    Watch: ReplicaSet 생성 감지            │
      │                              │                          │
      │                              ▼                          │
      │                    Pod 오브젝트 생성                      │
      │                    (spec.nodeName = "")                 │
      │                              │                          │
      │                              │                          ▼
      │                              │              Watch: unscheduled Pod 감지
      │                              │                          │
      │                              │                          ▼
      │                              │              Scheduling 알고리즘 실행
      │                              │                          │
      │                              │                          ▼
      │                              │              Pod.spec.nodeName = "node-2"
      │                              │              (API Server에 PATCH)
```

각 단계에서 새 리소스가 etcd에 기록되면, 다음 컨트롤러가 Watch로 이를 감지하여 연쇄 반응이 일어납니다. 이것이 Kubernetes의 **느슨한 결합(loose coupling)** 설계입니다. 각 컨트롤러는 서로를 직접 호출하지 않고, API Server(etcd)를 매개로 간접적으로 협력합니다.

### Deployment Controller의 Reconcile 로직

Deployment Controller의 Reconcile은 개략적으로 다음과 같이 동작합니다.

```go
func (dc *DeploymentController) Reconcile(deployment *appsv1.Deployment) error {
    // 1. 현재 소유한 ReplicaSet 목록 조회 (Indexer 캐시에서)
    rsList := dc.getReplicaSets(deployment)
    
    // 2. 새 RS가 필요한지 판단 (spec 변경 여부 확인)
    newRS, oldRSs := dc.getAllReplicaSetsAndSyncRevision(deployment, rsList)
    
    // 3. Strategy에 따라 롤아웃 수행
    switch deployment.Spec.Strategy.Type {
    case RollingUpdateDeploymentStrategyType:
        return dc.rolloutRolling(deployment, newRS, oldRSs)
    case RecreateDeploymentStrategyType:
        return dc.rolloutRecreate(deployment, newRS, oldRSs)
    }
}
```

RollingUpdate 전략의 경우, `maxSurge`와 `maxUnavailable` 설정에 따라 새 ReplicaSet을 점진적으로 스케일 업하고 기존 ReplicaSet을 스케일 다운합니다. 이 과정에서 Deployment Controller는 여러 번의 Reconcile 사이클을 반복합니다.

### OwnerReference와 가비지 컬렉션

Deployment가 생성한 ReplicaSet, ReplicaSet이 생성한 Pod는 모두 **OwnerReference**로 연결됩니다.

```yaml
# ReplicaSet의 metadata
metadata:
  ownerReferences:
  - apiVersion: apps/v1
    kind: Deployment
    name: nginx-deploy
    uid: "abc-123"
    controller: true
```

이 참조 덕분에 Deployment를 삭제하면 **Cascading Delete**로 하위 ReplicaSet과 Pod가 자동으로 정리됩니다. kube-controller-manager에 내장된 Garbage Collector가 OwnerReference 그래프를 추적하여 고아 리소스를 정리합니다.

## Phase 4: Scheduler — 노드 배치 결정

ReplicaSet Controller가 Pod 오브젝트를 생성하면, 이 Pod의 `spec.nodeName`은 비어 있습니다. Scheduler는 이런 **unscheduled Pod**를 Watch하다가 감지하면 **2단계 알고리즘**을 실행합니다.

### Scheduling Framework

```
┌──────────────────────────────────────────────────────┐
│               Scheduling Framework                    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Phase 1: Filtering (Predicates)              │    │
│  │                                               │    │
│  │  전체 노드 목록 [N1, N2, N3, N4, N5]          │    │
│  │      │                                        │    │
│  │      ├─ NodeResourcesFit    → N3 탈락 (CPU 부족)│   │
│  │      ├─ PodTopologySpread   → 통과              │   │
│  │      ├─ NodeAffinity        → N5 탈락           │   │
│  │      ├─ TaintToleration     → N4 탈락           │   │
│  │      │                                        │    │
│  │      ▼                                        │    │
│  │  후보 노드: [N1, N2]                           │    │
│  └──────────────────────────────────────────────┘    │
│                      │                                │
│                      ▼                                │
│  ┌──────────────────────────────────────────────┐    │
│  │  Phase 2: Scoring (Priorities)                │    │
│  │                                               │    │
│  │  N1: LeastRequestedPriority    = 70           │    │
│  │      ImageLocality             = 20           │    │
│  │      InterPodAffinity          = 50           │    │
│  │                          Total = 140          │    │
│  │                                               │    │
│  N2: LeastRequestedPriority    = 85           │    │
│  │      ImageLocality             = 0            │    │
│  │      InterPodAffinity          = 80           │    │
│  │                          Total = 165 ← 선택   │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

**Filtering 단계**에서는 Pod의 요구사항을 만족하지 못하는 노드를 제외합니다. CPU/메모리 부족, Taint 미허용, NodeAffinity 불일치 등이 필터링 사유가 됩니다. 모든 노드가 필터링되면 Pod는 Pending 상태로 남습니다.

**Scoring 단계**에서는 남은 후보 노드에 점수를 매겨 최적의 노드를 선택합니다. LeastRequestedPriority는 리소스 여유가 많은 노드에 높은 점수를, ImageLocality는 필요한 이미지가 이미 있는 노드에 높은 점수를 부여합니다.

### Scheduling Framework의 Extension Points

Kubernetes v1.19부터 Scheduling Framework는 플러그인 기반 아키텍처로 전환되었습니다. 각 단계에 Extension Point를 제공하여 커스텀 스케줄링 로직을 삽입할 수 있습니다.

```
PreFilter → Filter → PostFilter → PreScore → Score → 
Reserve → Permit → PreBind → Bind → PostBind
```

| Extension Point | 역할 | 예시 |
|-----|------|------|
| PreFilter | 사전 계산, Pod 정보 전처리 | Inter-pod affinity 사전 계산 |
| Filter | 부적합 노드 제외 | NodeResourcesFit, TaintToleration |
| Score | 후보 노드에 점수 부여 | LeastRequested, BalancedAllocation |
| Reserve | 선택된 노드에 리소스 예약 | 볼륨 바인딩 |
| Permit | 최종 승인/대기/거부 | Gang scheduling |
| Bind | Pod를 노드에 바인딩 | 기본: API Server에 PATCH |

GPU 워크로드를 다루는 환경에서는 **Extended Resources** (`nvidia.com/gpu`)가 Filter 단계의 NodeResourcesFit 플러그인에서 체크됩니다. Device Plugin이 노드의 GPU 수를 Allocatable에 보고하고, Scheduler가 이를 기반으로 필터링합니다.

## Phase 5: kubelet — 실제 컨테이너 실행

Scheduler가 노드를 배정하면, 해당 노드의 kubelet이 Watch를 통해 자신에게 배정된 새 Pod를 감지합니다. 이때부터 실제 컨테이너가 만들어지는 과정이 시작됩니다.

```
kubelet (Node Agent)
┌─────────────────────────────────────────────────────┐
│  1. Admission (kubelet 내부)                         │
│     - 리소스 충분한지 확인, eviction threshold 체크   │
│     - PodSecurityAdmission 검증                      │
├─────────────────────────────────────────────────────┤
│  2. CRI (Container Runtime Interface)               │
│     kubelet ──gRPC──▶ containerd/CRI-O              │
│                                                      │
│     RunPodSandbox()  → pause container 생성          │
│     CreateContainer() → app container 생성           │
│     StartContainer()  → container 시작               │
├─────────────────────────────────────────────────────┤
│  3. CNI (Container Network Interface)               │
│     - Pod IP 할당                                    │
│     - veth pair 생성                                 │
│     - 네트워크 네임스페이스 설정                       │
│     - (Calico/Cilium) eBPF/iptables 규칙 적용       │
├─────────────────────────────────────────────────────┤
│  4. CSI (Container Storage Interface)               │
│     - Volume Mount                                   │
│     - PVC → PV 바인딩 확인                           │
│     - Device mount → Container mount                 │
├─────────────────────────────────────────────────────┤
│  5. Probes 시작                                      │
│     - startupProbe → readinessProbe                  │
│     - livenessProbe (주기적)                          │
├─────────────────────────────────────────────────────┤
│  6. Status 보고                                      │
│     kubelet → API Server (Pod status 업데이트)        │
│     conditions: [{type: Ready, status: True}]        │
└─────────────────────────────────────────────────────┘
```

### CRI 호출 흐름

kubelet은 컨테이너 런타임과 **gRPC**로 통신합니다. CRI(Container Runtime Interface) 명세에 따라 표준화된 호출을 사용하므로, containerd든 CRI-O든 동일한 인터페이스로 동작합니다.

```
kubelet
  │
  │ gRPC: RunPodSandbox(PodSandboxConfig)
  ▼
containerd ──────▶ runc (OCI runtime)
  │                    │
  │                    ├─ Linux namespaces 생성 (net, ipc, uts)
  │                    ├─ cgroups 설정 (CPU/Memory limits)
  │                    ├─ seccomp/AppArmor 프로파일 적용
  │                    └─ pause container 실행 (네트워크 네임스페이스 홀더)
  │
  │ gRPC: CreateContainer(PodSandboxId, ContainerConfig)
  ▼
containerd
  │
  │ gRPC: StartContainer(ContainerId)
  ▼
containerd ──────▶ runc
                       │
                       └─ 실제 애플리케이션 프로세스 실행
```

**RunPodSandbox**가 먼저 실행되는 이유가 중요합니다. Sandbox(pause container)가 **네트워크 네임스페이스를 소유**합니다. 이후 생성되는 모든 컨테이너는 이 sandbox의 네트워크 네임스페이스에 합류하기 때문에, 같은 Pod 내 컨테이너들이 localhost로 서로 통신할 수 있는 것입니다.

runc는 실제로 Linux 커널의 **namespace**, **cgroups**, **seccomp** 등을 호출하여 컨테이너 격리 환경을 만듭니다. 이전에 [systemd와 cgroups의 관계](/linux/linux-systemd)와 연결되는 부분입니다. Kubernetes Pod의 `resources.limits`가 결국 cgroup 설정으로 변환되는 것이죠.

### CNI — 네트워크 설정

Sandbox가 생성되면 kubelet은 CNI 플러그인을 호출하여 네트워크를 설정합니다.

```
kubelet → CNI binary 실행 (ADD 명령)
    │
    ▼
┌─────────────────────────────────────────────┐
│ CNI 플러그인 (예: Calico)                   │
│                                             │
│  1. IPAM: Pod IP 할당 (예: 10.244.1.5)      │
│  2. veth pair 생성                           │
│     - Pod 측: eth0 (Pod 네트워크 네임스페이스)│
│     - Host 측: cali-xxxx (호스트 네임스페이스)│
│  3. 라우팅 규칙 설정                         │
│  4. eBPF/iptables 규칙 적용                  │
└─────────────────────────────────────────────┘
```

CNI 플러그인에 따라 구현은 다르지만(Calico, Cilium, Flannel 등), 결과적으로 Pod가 클러스터 내에서 고유한 IP를 받고 다른 Pod와 통신할 수 있는 네트워크가 구성됩니다.

### Probes와 트래픽 유입

컨테이너가 시작된 후 바로 트래픽을 받는 것이 아닙니다. Probe 체크를 통과해야 합니다.

```
Container 시작
    │
    ▼
startupProbe 시작 (설정된 경우) ← 통과할 때까지 다른 probe 비활성
    ▼
readinessProbe 시작
    │ ← True가 되면 Endpoints에 등록
    ▼
Endpoint Controller: Pod Ready 감지 → Endpoints/EndpointSlice 업데이트
    │
    ▼
kube-proxy: Endpoints 변경 감지 → iptables/IPVS 규칙 업데이트
    │
    ▼
트래픽 수신 가능!
```

readinessProbe가 통과되면 Endpoint Controller가 이를 감지하여 Service의 Endpoints에 Pod IP를 등록합니다. kube-proxy가 이 변경을 Watch하여 iptables/IPVS 규칙을 업데이트하면, 비로소 외부 트래픽이 이 Pod에 도달할 수 있게 됩니다.

## 전체 흐름 타임라인

지금까지 살펴본 전체 과정을 시간순으로 정리하면 다음과 같습니다.

```
t=0ms    kubectl apply -f deployment.yaml
         │
t=1ms    API Server: Authentication ✓
t=2ms    API Server: Authorization (RBAC) ✓
t=3ms    API Server: Mutating Admission Webhooks ✓
t=4ms    API Server: Schema Validation ✓
t=5ms    API Server: Validating Admission ✓
t=6ms    API Server: etcd write (Deployment 저장)
t=7ms    API Server → Client: 201 Created
         │
t=10ms   Deployment Controller: Watch 이벤트 수신
t=12ms   Deployment Controller: ReplicaSet 생성 (API Server POST)
         │
t=15ms   ReplicaSet Controller: Watch 이벤트 수신
t=18ms   ReplicaSet Controller: Pod 생성 (spec.nodeName = "")
         │
t=25ms   Scheduler: Watch로 unscheduled Pod 감지
t=30ms   Scheduler: Filter + Score 완료
t=32ms   Scheduler: Pod.spec.nodeName = "node-2" (PATCH)
         │
t=40ms   kubelet (node-2): Watch로 신규 Pod 감지
t=50ms   kubelet: CRI — Sandbox 생성
t=60ms   kubelet: CNI — 네트워크 설정
t=70ms   kubelet: CSI — 볼륨 마운트
t=100ms  kubelet: Container 시작
t=200ms  kubelet: startupProbe 통과
t=250ms  kubelet: readinessProbe 통과
t=260ms  kubelet: Pod status → Running, Ready (API Server 업데이트)
         │
         ▼
         Endpoint Controller: Pod Ready 감지 → Endpoints 업데이트
         kube-proxy: Endpoints 변경 감지 → iptables/IPVS 규칙 업데이트
         트래픽 수신 가능!
```

## 핵심 설계 원칙

전체 흐름을 관통하는 Kubernetes의 설계 원칙 세 가지를 정리합니다.

### Level-triggered, not Edge-triggered

Kubernetes 컨트롤러는 "무슨 이벤트가 발생했는가"(Edge-triggered)가 아니라 **"현재 상태와 원하는 상태의 차이가 무엇인가"**(Level-triggered)를 기준으로 동작합니다.

Watch 이벤트를 놓치더라도 다음 Reconcile 사이클에서 현재 상태를 확인하고 원하는 상태와의 차이를 감지하여 복구합니다. 이 설계 덕분에 네트워크 순단이나 API Server 재시작 같은 일시적 장애에도 최종적으로 원하는 상태에 수렴합니다.

### Optimistic Concurrency (낙관적 동시성 제어)

모든 Kubernetes 오브젝트는 `metadata.resourceVersion` 필드를 가집니다. 이 값은 etcd의 MVCC(Multi-Version Concurrency Control) revision에 매핑됩니다.

오브젝트를 업데이트할 때, resourceVersion이 현재 etcd에 저장된 버전과 일치해야만 성공합니다. 두 컨트롤러가 동시에 같은 오브젝트를 수정하려고 하면 먼저 성공한 쪽만 반영되고, 늦은 쪽은 `409 Conflict`를 받아 재시도합니다.

```
Controller A: GET Pod (resourceVersion: 100)
Controller B: GET Pod (resourceVersion: 100)
Controller A: PUT Pod (resourceVersion: 100) → 성공 (새 resourceVersion: 101)
Controller B: PUT Pod (resourceVersion: 100) → 409 Conflict → 재시도
```

### 단일 진실 공급원 (Single Source of Truth)

모든 클러스터 상태는 **etcd에만** 저장됩니다. Controller, kubelet, Scheduler 등은 Informer를 통해 로컬 캐시를 유지하지만, 이는 읽기 최적화를 위한 것일 뿐입니다. 상태 변경은 반드시 API Server → etcd 경로를 통해 이루어지며, 다른 모든 컴포넌트는 이 변경을 Watch로 전파받습니다.

이 원칙이 있기에 어떤 컴포넌트가 재시작되더라도 etcd에서 현재 상태를 List로 다시 불러와 정상적으로 동작을 재개할 수 있습니다.

## 정리

`kubectl apply` 한 줄이 실행되면 API Server의 인증/인가/Admission 체인, Controller의 Informer 기반 감지와 Reconciliation, Scheduler의 Filter/Score 알고리즘, kubelet의 CRI/CNI/CSI 호출이 연쇄적으로 동작하여 최종적으로 컨테이너가 실행되고 트래픽을 수신하게 됩니다.

각 단계를 요약하면 다음과 같습니다.

| 단계 | 컴포넌트 | 핵심 동작 |
|-----|---------|--------|
| 1. 요청 전송 | kubectl | kubeconfig 인증 정보로 REST API 호출 |
| 2. 요청 처리 | API Server | 인증 → 인가 → Mutating → Validation → Validating → etcd 저장 |
| 3. 상태 실현 | Controller Manager | Informer로 변경 감지 → Reconcile → 하위 리소스 생성 |
| 4. 노드 배치 | Scheduler | Filter(부적합 제외) → Score(최적 선택) → nodeName 바인딩 |
| 5. 컨테이너 실행 | kubelet | CRI(런타임) → CNI(네트워크) → CSI(스토리지) → Probes → Ready |

이 흐름을 이해하면 Kubernetes 운영 중 마주치는 많은 문제들, Pod가 Pending인 이유, CrashLoopBackOff의 원인, 배포 후 트래픽이 즉시 전달되지 않는 이유 등을 체계적으로 진단할 수 있습니다.

## References

- [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/)
- [API Server](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Authorization Overview](https://kubernetes.io/docs/reference/access-authn-authz/authorization/)
- [Admission Controllers](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/)
- [kube-controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/)
- [Kubernetes Scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
- [kubelet](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/)
- [Container Runtime Interface (CRI)](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
