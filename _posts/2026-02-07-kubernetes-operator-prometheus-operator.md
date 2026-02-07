---
layout: single
title: "Kubernetes Operator 동작 원리: Prometheus Operator로 깊이 이해하기"
date: 2026-02-07 11:00:00 +0900
categories: kubernetes
tags: [kubernetes, operator, crd, prometheus, custom-controller, informer, reconciliation, servicemonitor]
excerpt: "Kubernetes Operator는 어떻게 동작할까? CRD로 API를 확장하는 원리부터 Custom Controller의 Informer 아키텍처, Reconcile 루프까지 Prometheus Operator를 예시로 내부 동작을 깊이 있게 살펴봅니다."
---

## 들어가며

"Prometheus를 Kubernetes에 배포해주세요. 레플리카 3개, 보존 기간 15일, 그리고 새 서비스가 추가되면 모니터링이 자동으로 적용되게 해주세요."

이 요구사항을 Deployment와 ConfigMap만으로 구현하려면 꽤 복잡해집니다. scrape_config를 직접 수정하고, ConfigMap을 업데이트하고, Prometheus를 reload하는 과정을 매번 수동으로 해야 합니다. 서비스가 10개, 100개로 늘어나면 관리가 불가능에 가까워지죠.

Kubernetes Operator는 이 문제를 근본적으로 해결합니다. **"Prometheus 서버를 운영하는 전문가의 지식"** 을 소프트웨어로 인코딩하여, 사용자는 원하는 상태만 선언하면 나머지는 Operator가 알아서 처리합니다.

이 글에서는 Operator 패턴의 핵심 개념인 CRD와 Custom Controller의 구조를 살펴보고, Prometheus Operator를 예시로 실제 동작 원리를 깊이 있게 다루겠습니다. [이전 글의 리소스 생성 흐름](/kubernetes/2026/02/07/kubernetes-resource-creation-flow)에서 다뤘던 Informer 아키텍처와 Reconciliation 개념이 여기서도 핵심적으로 등장합니다.

## Operator Pattern이란?

### 내장 컨트롤러의 한계

이전 글에서 Kubernetes의 핵심 루프를 다뤘습니다.

```
Desired State (etcd) ←→ Reconciliation Loop ←→ Current State (클러스터)
```

Deployment Controller, ReplicaSet Controller 같은 내장 컨트롤러는 Pod, ReplicaSet 같은 **범용 리소스** 를 관리합니다. 하지만 "Prometheus 서버를 3개 레플리카로 운영하면서 특정 ServiceMonitor 설정을 자동 적용해라" 같은 **도메인 특화 운영 로직** 은 내장 컨트롤러로 표현할 수 없습니다.

Operator는 이 문제를 해결합니다.

```
┌──────────────────────────────────────────────────────────────┐
│                  Operator = CRD + Custom Controller           │
│                                                              │
│  ┌────────────────────┐     ┌───────────────────────────┐    │
│  │  Custom Resource    │     │   Custom Controller       │    │
│  │  Definition (CRD)   │     │                           │    │
│  │                     │     │  "도메인 전문가의 운영     │    │
│  │  "무엇을 원하는가"  │     │   지식을 코드로 구현"     │    │
│  │                     │     │                           │    │
│  │  예: Prometheus     │     │  예: Prometheus가 3개     │    │
│  │      replicas: 3   │     │      레플리카로 동작하려면 │    │
│  │      retention: 7d │     │      StatefulSet, Service, │    │
│  │                     │     │      ConfigMap, Secret을   │    │
│  │                     │     │      어떻게 만들어야 하는지│    │
│  └────────────────────┘     └───────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

공식 문서의 정의를 빌리면, Operator는 **Custom Resource를 사용하여 애플리케이션과 그 컴포넌트를 관리하는 Kubernetes의 소프트웨어 확장** 입니다. 핵심은 Human Operator(운영자)의 지식을 소프트웨어로 인코딩하는 것입니다.

## CRD (Custom Resource Definition) — API 확장

### CRD의 역할

CRD는 Kubernetes API를 확장하여 **새로운 리소스 타입** 을 등록합니다. CRD를 등록하면 그 즉시 API Server가 해당 리소스에 대한 RESTful 엔드포인트를 자동 생성합니다.

```
CRD 등록 전:
  GET /apis/monitoring.coreos.com/v1/prometheuses → 404 Not Found

CRD 등록 후:
  GET /apis/monitoring.coreos.com/v1/prometheuses → 200 OK
  POST, PUT, PATCH, DELETE 모두 사용 가능
```

이것이 가능한 이유는 API Server의 **API Aggregation Layer** 때문입니다. CRD가 등록되면 API Server는 해당 리소스의 스키마를 인메모리에 로드하고, etcd에 저장/조회하는 핸들러를 동적으로 생성합니다.

### CRD의 내부 구조

CRD 자체도 Kubernetes 리소스입니다. Prometheus Operator가 등록하는 CRD 중 하나인 `Prometheus` CRD의 구조를 살펴보겠습니다.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: prometheuses.monitoring.coreos.com
spec:
  group: monitoring.coreos.com          # API 그룹
  names:
    kind: Prometheus                     # 리소스 타입명
    listKind: PrometheusList
    plural: prometheuses                 # URL 경로에 사용
    singular: prometheus
    shortNames: ["prom"]                 # kubectl get prom 가능
  scope: Namespaced                      # Namespace 범위
  versions:
  - name: v1
    served: true                         # 이 버전으로 API 서빙
    storage: true                        # etcd에 이 버전으로 저장
    schema:
      openAPIV3Schema:                   # 스키마 검증
        type: object
        properties:
          spec:
            type: object
            properties:
              replicas:
                type: integer
                minimum: 1
              retention:
                type: string
                pattern: "^[0-9]+(y|w|d|h|m|s)$"
              serviceMonitorSelector:
                type: object
                properties:
                  matchLabels:
                    type: object
                    additionalProperties:
                      type: string
    additionalPrinterColumns:            # kubectl get 출력 컬럼
    - name: Version
      type: string
      jsonPath: .spec.version
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
    subresources:
      status: {}                         # /status 서브리소스 활성화
      scale:                             # /scale 서브리소스 (HPA 연동)
        specReplicasPath: .spec.replicas
        statusReplicasPath: .status.replicas
```

핵심 필드를 하나씩 짚어보겠습니다.

**openAPIV3Schema** 는 CRD에 대한 스키마 검증 규칙입니다. 이전 글에서 다뤘던 API Server의 Schema Validation 단계에서 이 스키마가 사용됩니다. `replicas` 가 최소 1이어야 하고, `retention` 이 정규식 패턴을 따라야 한다는 제약을 선언적으로 정의합니다.

**subresources.status** 로 `/status` 서브리소스를 활성화하면, 메인 스펙과 상태를 별도의 엔드포인트로 분리합니다. 이것이 중요한 이유가 두 가지 있습니다. 첫째, RBAC에서 일반 사용자에게는 `spec` 수정만 허용하고 Controller에게만 `status` 업데이트를 허용할 수 있습니다. 둘째, Optimistic Concurrency에서 spec 변경과 status 변경이 서로 충돌하지 않습니다.

```
PUT /apis/.../prometheuses/main
  → spec만 변경 가능 (사용자)

PUT /apis/.../prometheuses/main/status
  → status만 변경 가능 (Controller)
```

**subresources.scale** 은 HPA(Horizontal Pod Autoscaler)가 이 리소스를 스케일링 대상으로 인식할 수 있게 합니다. `specReplicasPath` 와 `statusReplicasPath` 를 지정하면 HPA가 표준 Scale API로 레플리카 수를 조회/변경할 수 있습니다.

### CRD 등록 시 API Server 내부 동작

CRD가 API Server에 등록되면 내부적으로 다음 과정이 진행됩니다.

```
CRD 생성 요청
    │
    ▼
API Server: CRD 오브젝트를 etcd에 저장
    │
    ▼
CRD Controller (내장): 새 CRD 감지
    │
    ├─ OpenAPI 스키마를 API Server에 동적 등록
    ├─ RESTful 핸들러 생성 (CRUD)
    ├─ etcd 저장 경로 설정: /registry/{group}/{resource}/{namespace}/{name}
    └─ API Discovery 엔드포인트 업데이트
    │
    ▼
새 API 엔드포인트 사용 가능
  /apis/monitoring.coreos.com/v1/namespaces/*/prometheuses
```

CRD가 등록되는 순간 **API Server 재시작 없이** 새 엔드포인트가 활성화됩니다. 이것이 Kubernetes의 확장성을 가능하게 하는 핵심 메커니즘입니다.

## Prometheus Operator 아키텍처

### Prometheus Operator가 관리하는 CRD들

Prometheus Operator는 5개의 주요 CRD를 등록합니다. 각 CRD가 Prometheus 운영의 어떤 측면을 추상화하는지 보겠습니다.

```
┌───────────────────────────────────────────────────────────────────┐
│                     Prometheus Operator CRDs                      │
│                                                                   │
│  ┌──────────────┐    ┌───────────────┐    ┌─────────────────┐    │
│  │  Prometheus   │    │ Alertmanager  │    │   ThanosRuler   │    │
│  │              │    │               │    │                 │    │
│  │ "Prometheus  │    │ "Alertmanager │    │ "Thanos Ruler   │    │
│  │  서버 자체"   │    │  서버 자체"    │    │  인스턴스"       │    │
│  └──────┬───────┘    └───────────────┘    └─────────────────┘    │
│         │                                                         │
│         │ 참조                                                    │
│         │                                                         │
│  ┌──────▼───────┐    ┌───────────────┐                           │
│  │ServiceMonitor│    │PrometheusRule │                            │
│  │              │    │               │                            │
│  │ "무엇을      │    │ "어떤 알림    │                            │
│  │  스크래핑할   │    │  규칙을       │                            │
│  │  것인가"     │    │  적용할 것인가"│                            │
│  └──────────────┘    └───────────────┘                           │
└───────────────────────────────────────────────────────────────────┘
```

| CRD | 역할 | 생성되는 하위 리소스 |
|-----|------|-------------------|
| **Prometheus** | Prometheus 서버 인스턴스 정의 | StatefulSet, Service, ConfigMap, Secret, ServiceAccount |
| **ServiceMonitor** | 스크래핑 대상 서비스 정의 | Prometheus ConfigMap에 scrape_config 주입 |
| **PrometheusRule** | 알림/레코딩 규칙 정의 | Prometheus ConfigMap에 rule_files 주입 |
| **Alertmanager** | Alertmanager 인스턴스 정의 | StatefulSet, Service, ConfigMap |
| **ThanosRuler** | Thanos Ruler 인스턴스 정의 | StatefulSet, Service |

### 전체 동작 흐름

Prometheus CR을 하나 생성했을 때 내부적으로 어떤 일이 벌어지는지 전체 흐름을 보겠습니다.

```
사용자: kubectl apply -f prometheus.yaml
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  API Server                                                  │
│  - Authentication/Authorization/Admission 통과                │
│  - Prometheus CR을 etcd에 저장                                │
└─────────────────────────────┬────────────────────────────────┘
                              │ Watch 이벤트
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Prometheus Operator (Custom Controller)                      │
│                                                              │
│  Informer가 Prometheus CR 생성 이벤트 감지                    │
│         │                                                    │
│         ▼                                                    │
│  Reconcile 함수 실행                                         │
│         │                                                    │
│         ├─ 1. ServiceAccount 생성/업데이트                     │
│         ├─ 2. ClusterRole/ClusterRoleBinding 설정             │
│         ├─ 3. Service 생성 (Prometheus 웹 UI/API 접근용)       │
│         ├─ 4. Secret 생성 (TLS 인증서, 인증 정보)              │
│         ├─ 5. ConfigMap 생성                                  │
│         │     ├─ ServiceMonitor → scrape_configs 변환         │
│         │     └─ PrometheusRule → rule_files 변환             │
│         ├─ 6. StatefulSet 생성/업데이트                        │
│         │     ├─ replicas: spec에서 지정한 수                  │
│         │     ├─ volumeClaimTemplates: 스토리지 설정           │
│         │     └─ containers: prometheus, config-reloader      │
│         └─ 7. Status 업데이트                                 │
│               └─ conditions, availableReplicas 등              │
└──────────────────────────────────────────────────────────────┘
         │
         ▼  (생성된 StatefulSet, Service 등)
┌──────────────────────────────────────────────────────────────┐
│  내장 컨트롤러들 (kube-controller-manager)                    │
│                                                              │
│  StatefulSet Controller → Pod 생성 (순차적, 안정적 이름)      │
│  Service Controller → Endpoints 관리                          │
│  PV Controller → PVC-PV 바인딩                                │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  kubelet: Pod 실행                                           │
│  - Prometheus 컨테이너 기동                                   │
│  - config-reloader sidecar 기동                               │
│  - PVC 마운트 (TSDB 데이터 저장)                              │
└──────────────────────────────────────────────────────────────┘
```

Operator가 생성한 StatefulSet은 이전 글에서 다뤘던 내장 컨트롤러 체인(StatefulSet Controller → Pod 생성 → Scheduler → kubelet)을 그대로 타게 됩니다. Operator는 도메인 특화 리소스를 Kubernetes 네이티브 리소스로 변환하는 역할을 하고, 이후의 실행은 Kubernetes 자체에 위임하는 구조입니다.

### 실제 CR 예시와 생성되는 리소스

다음과 같은 Prometheus CR을 생성한다고 합시다.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: main
  namespace: monitoring
spec:
  replicas: 3
  retention: 15d
  version: v2.51.0
  serviceAccountName: prometheus
  serviceMonitorSelector:
    matchLabels:
      team: platform
  ruleSelector:
    matchLabels:
      role: alert-rules
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
  resources:
    requests:
      cpu: "2"
      memory: "8Gi"
    limits:
      cpu: "4"
      memory: "16Gi"
```

Operator의 Reconcile이 이 CR을 처리하면 다음 리소스들이 자동으로 생성됩니다.

```
kubectl apply -f prometheus.yaml 이후:

monitoring 네임스페이스:
├── prometheus/main (Prometheus CR) ← 사용자가 생성
│
├── statefulset/prometheus-main     ← Operator가 생성
│   ├── pod/prometheus-main-0
│   ├── pod/prometheus-main-1
│   └── pod/prometheus-main-2
│
├── service/prometheus-main         ← Operator가 생성
│   └── port: 9090 (web), 8080 (reloader)
│
├── configmap/prometheus-main-rulefiles  ← Operator가 생성
│   └── PrometheusRule에서 변환된 rule files
│
├── secret/prometheus-main               ← Operator가 생성
│   └── prometheus.yaml.gz (scrape config)
│
├── serviceaccount/prometheus            ← Operator가 생성
│
├── pvc/prometheus-main-db-prometheus-main-0  ← StatefulSet이 생성
├── pvc/prometheus-main-db-prometheus-main-1
└── pvc/prometheus-main-db-prometheus-main-2
```

사용자는 Prometheus CR 하나만 관리하면 되고, 6~7종의 하위 리소스 생성과 관리는 Operator가 전담합니다.

### StatefulSet을 사용하는 이유

Prometheus Operator가 Deployment가 아닌 **StatefulSet** 을 선택한 데는 명확한 이유가 있습니다.

| 요구사항 | Deployment | StatefulSet |
|---------|-----------|-------------|
| 안정적인 네트워크 ID | ❌ 랜덤 이름 | ✅ prometheus-main-0, 1, 2 |
| 안정적인 스토리지 | ❌ Pod 재생성 시 데이터 손실 | ✅ PVC가 Pod에 1:1 매핑 |
| 순차적 배포/스케일링 | ❌ 동시 생성 | ✅ 0 → 1 → 2 순서 보장 |
| TSDB 데이터 보존 | ❌ | ✅ Pod가 재시작되어도 PVC 유지 |

Prometheus는 TSDB(Time Series Database) 데이터를 로컬 디스크에 저장합니다. Pod가 재시작되더라도 같은 PVC에 다시 마운트되어야 수집된 메트릭 데이터가 보존됩니다. 이런 stateful한 워크로드의 특성을 StatefulSet이 정확히 해결합니다.

## Custom Controller 내부 구조

### Controller의 Informer 구성

이전 글에서 다뤘던 Informer 아키텍처가 여기서도 동일하게 적용됩니다. 다만 Prometheus Operator의 Controller는 **여러 리소스를 동시에 Watch** 한다는 점이 다릅니다.

```
┌──────────────────────────────────────────────────────────────┐
│               Prometheus Operator Controller                  │
│                                                              │
│  Informers (각각 List & Watch):                               │
│  ┌──────────────────┐  ┌───────────────────┐                 │
│  │ Prometheus        │  │ ServiceMonitor     │                 │
│  │ Informer         │  │ Informer          │                 │
│  └─────────┬────────┘  └─────────┬─────────┘                 │
│            │                      │                           │
│  ┌─────────┴────────┐  ┌─────────┴─────────┐                 │
│  │ PrometheusRule    │  │ StatefulSet       │                 │
│  │ Informer         │  │ Informer          │                 │
│  └─────────┬────────┘  └─────────┬─────────┘                 │
│            │                      │                           │
│  ┌─────────┴────────┐  ┌─────────┴─────────┐                 │
│  │ ConfigMap         │  │ Secret            │                 │
│  │ Informer         │  │ Informer          │                 │
│  └─────────┬────────┘  └─────────┬─────────┘                 │
│            │                      │                           │
│            └───────────┬──────────┘                           │
│                        ▼                                      │
│                ┌──────────────┐                               │
│                │  Work Queue  │                               │
│                │  (key:       │                               │
│                │   namespace/ │                               │
│                │   name)      │                               │
│                └──────┬───────┘                               │
│                       │                                       │
│                       ▼                                       │
│                ┌──────────────┐                               │
│                │  Reconcile() │                               │
│                └──────────────┘                               │
└──────────────────────────────────────────────────────────────┘
```

핵심은 **어떤 리소스가 변경되든 최종적으로 같은 Work Queue에 Prometheus CR의 키가 들어간다** 는 것입니다.

예를 들어 ServiceMonitor가 변경되면, Operator는 이 ServiceMonitor를 참조하는 Prometheus CR이 무엇인지를 역방향으로 조회하여 해당 CR의 키를 큐에 넣습니다.

```
ServiceMonitor "app-metrics" 변경
    │
    ▼
Event Handler: "이 ServiceMonitor의 label이 team=platform"
    │
    ▼
Indexer 조회: "serviceMonitorSelector: {team: platform}인 Prometheus는?"
    │
    ▼
결과: Prometheus "main"
    │
    ▼
Work Queue에 "monitoring/main" enqueue
    │
    ▼
Reconcile("monitoring/main") 실행
```

이 패턴을 **Cross-resource Reconciliation** 이라 하며, Operator 개발에서 가장 중요한 설계 패턴 중 하나입니다. 직접적인 Prometheus CR 변경뿐 아니라, 관련된 ServiceMonitor, PrometheusRule, 심지어 하위 StatefulSet의 변경까지 모두 동일한 Reconcile 함수로 수렴합니다.

### Reconcile 로직 상세

Reconcile 함수는 **멱등성(idempotent)** 을 보장해야 합니다. 몇 번을 실행하든 결과가 동일해야 한다는 원칙입니다.

```
Reconcile("monitoring/main") 실행:
    │
    ▼
┌─ 1. Prometheus CR 조회 ───────────────────────────────┐
│  - Indexer(로컬 캐시)에서 조회                         │
│  - 없으면 삭제된 것 → 정리(cleanup) 로직 실행          │
│  - DeletionTimestamp가 있으면 → Finalizer 처리         │
└────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 2. ServiceMonitor 수집 ──────────────────────────────┐
│  - spec.serviceMonitorSelector에 매칭되는 SM 조회      │
│  - 네임스페이스 필터링 (serviceMonitorNamespaceSelector)│
│  - 각 SM의 endpoints를 Prometheus scrape_config로 변환 │
│                                                       │
│  ServiceMonitor:              변환 결과:               │
│  spec:                        scrape_configs:         │
│    selector:                  - job_name: ns/app      │
│      matchLabels:               kubernetes_sd_configs: │
│        app: my-app              - role: endpoints     │
│    endpoints:                   relabel_configs:       │
│    - port: metrics              - source_labels:      │
│      path: /metrics               [__meta_...]        │
└────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 3. PrometheusRule 수집 ──────────────────────────────┐
│  - spec.ruleSelector에 매칭되는 Rule 조회              │
│  - YAML rule_files로 변환                              │
│  - ConfigMap에 저장                                    │
└────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 4. 하위 리소스 생성/업데이트 ────────────────────────┐
│                                                       │
│  각 리소스에 대해 "Create or Update" 패턴 적용:        │
│                                                       │
│  existing := GET(resource)                            │
│  if NotFound:                                         │
│      CREATE(desired)                                  │
│  else:                                                │
│      if existing.spec != desired.spec:                │
│          UPDATE(desired with existing.resourceVersion) │
│      else:                                            │
│          // 변경 없음, skip                            │
│                                                       │
│  적용 순서:                                            │
│  ServiceAccount → RBAC → Secret → ConfigMap           │
│  → Service → StatefulSet                              │
└────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 5. Status 업데이트 ──────────────────────────────────┐
│  PATCH /apis/.../prometheuses/main/status             │
│                                                       │
│  status:                                              │
│    availableReplicas: 3                               │
│    conditions:                                        │
│    - type: Available                                  │
│      status: "True"                                   │
│    - type: Reconciled                                 │
│      status: "True"                                   │
└────────────────────────────────────────────────────────┘
```

4단계의 "Create or Update" 패턴에서 `existing.resourceVersion` 을 사용하는 부분이 중요합니다. 이전 글에서 다뤘던 Optimistic Concurrency가 여기서 적용됩니다. 다른 컨트롤러나 사용자가 동시에 같은 리소스를 수정하고 있다면 409 Conflict를 받고 재시도합니다.

### OwnerReference와 Garbage Collection

이전 글에서 다뤘던 OwnerReference가 Operator에서도 핵심적인 역할을 합니다. Operator가 생성하는 모든 하위 리소스에는 Prometheus CR을 가리키는 OwnerReference가 설정됩니다.

```yaml
# Operator가 생성한 StatefulSet의 metadata
metadata:
  name: prometheus-main
  ownerReferences:
  - apiVersion: monitoring.coreos.com/v1
    kind: Prometheus
    name: main
    uid: "abc-123-def"
    controller: true
    blockOwnerDeletion: true
```

이 참조 덕분에 `kubectl delete prometheus main` 을 실행하면 StatefulSet, Service, ConfigMap 등이 **Cascading Delete** 로 자동 정리됩니다. Operator가 별도의 삭제 로직을 구현하지 않아도 Kubernetes의 Garbage Collector가 처리해줍니다.

다만 외부 리소스(예: 클라우드 스토리지, DNS 레코드)는 Kubernetes GC가 관리할 수 없으므로, **Finalizer** 를 사용하여 Operator가 직접 정리해야 합니다.

### Finalizer 패턴

Finalizer는 오브젝트 삭제 전에 정리 작업을 보장하는 메커니즘입니다.

```yaml
# Finalizer가 설정된 Prometheus CR
metadata:
  name: main
  finalizers:
  - monitoring.coreos.com/prometheus-finalizer
  deletionTimestamp: "2026-02-07T10:00:00Z"  # 삭제 요청됨
```

동작 흐름은 다음과 같습니다.

```
사용자: kubectl delete prometheus main
    │
    ▼
API Server: DeletionTimestamp 설정 (즉시 삭제하지 않음)
    │
    ▼
Operator: Reconcile 실행 → DeletionTimestamp 존재 확인
    │
    ├─ 외부 리소스 정리 (예: S3 버킷의 백업 데이터)
    ├─ 정리 완료 확인
    └─ Finalizer 제거: metadata.finalizers에서 제거
    │
    ▼
API Server: Finalizer가 비었으므로 오브젝트 실제 삭제
    │
    ▼
GC: OwnerReference 기반으로 하위 리소스 Cascading Delete
```

Finalizer가 있는 한 오브젝트는 etcd에서 실제로 삭제되지 않습니다. Operator가 정리 작업을 완료하고 Finalizer를 제거해야 비로소 삭제됩니다. 이 메커니즘이 없다면 외부 리소스가 orphan 상태로 남아 비용이 계속 발생하는 문제가 생길 수 있습니다.

## ServiceMonitor → Prometheus 설정 변환 과정

Operator의 가장 강력한 기능 중 하나는 **ServiceMonitor를 Prometheus의 native 설정으로 자동 변환** 하는 것입니다. 이 과정을 상세히 보겠습니다.

### ServiceMonitor 정의

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: app-metrics
  namespace: production
  labels:
    team: platform              # Prometheus의 serviceMonitorSelector와 매칭
spec:
  namespaceSelector:
    matchNames: ["production"]
  selector:
    matchLabels:
      app: my-app               # 이 label을 가진 Service를 대상으로
  endpoints:
  - port: metrics               # Service의 port 이름
    path: /metrics
    interval: 30s
    scrapeTimeout: 10s
```

### 변환 결과

Operator는 이 ServiceMonitor를 다음과 같은 Prometheus native scrape_config로 변환합니다.

```yaml
# Operator가 생성한 Prometheus 설정 (Secret에 저장)
scrape_configs:
- job_name: serviceMonitor/production/app-metrics/0
  honor_labels: false
  kubernetes_sd_configs:
  - role: endpoints
    namespaces:
      names: ["production"]
    selectors:
    - role: endpoints
      label: "app=my-app"
  scrape_interval: 30s
  scrape_timeout: 10s
  metrics_path: /metrics
  relabel_configs:
  # Service의 port 이름으로 필터링
  - source_labels: [__meta_kubernetes_service_port_name]
    regex: metrics
    action: keep
  # 메타데이터 label 추가
  - source_labels: [__meta_kubernetes_namespace]
    target_label: namespace
  - source_labels: [__meta_kubernetes_service_name]
    target_label: service
  - source_labels: [__meta_kubernetes_pod_name]
    target_label: pod
```

사용자는 직관적인 ServiceMonitor 형태로 스크래핑 대상을 정의하기만 하면, Operator가 Prometheus가 이해할 수 있는 native 설정으로 자동 변환합니다. `kubernetes_sd_configs` 와 `relabel_configs` 같은 복잡한 설정을 직접 작성할 필요가 없어집니다.

### Config Reload 메커니즘

설정이 변경되면 Prometheus 프로세스를 재시작하지 않고 **config-reloader sidecar** 가 설정을 갱신합니다.

```
ServiceMonitor 변경
    │
    ▼
Operator: Reconcile → Secret/ConfigMap 업데이트
    │
    ▼
config-reloader sidecar: 파일 변경 감지 (inotify/polling)
    │
    ▼
Prometheus에 HTTP POST /-/reload 전송
    │
    ▼
Prometheus: 설정 재로드 (다운타임 없음)
```

StatefulSet 내부의 config-reloader container는 다음과 같이 구성됩니다.

```yaml
containers:
- name: config-reloader
  image: quay.io/prometheus-operator/prometheus-config-reloader
  args:
  - --reload-url=http://localhost:9090/-/reload
  - --config-file=/etc/prometheus/config/prometheus.yaml.gz
  - --config-envsubst-file=/etc/prometheus/config_out/prometheus.env.yaml
  volumeMounts:
  - name: config
    mountPath: /etc/prometheus/config
    readOnly: true
```

이 설계 덕분에 새로운 ServiceMonitor를 추가하거나 PrometheusRule을 변경해도 Prometheus Pod 재시작 없이 설정이 반영됩니다. 프로덕션 환경에서 모니터링 설정을 변경할 때마다 메트릭 수집이 중단되는 일이 없습니다.

## 전체 시퀀스: 새 서비스 모니터링 추가

모든 것을 종합하여, 새로운 서비스의 모니터링을 추가하는 전체 시퀀스를 보겠습니다.

```
t=0ms    개발팀: ServiceMonitor "app-metrics" 생성
         │
t=5ms    API Server: 인증/인가/Admission → etcd 저장
         │
t=15ms   Operator: ServiceMonitor Informer가 이벤트 감지
         │
t=16ms   Operator: "이 SM의 label(team=platform)과 매칭되는 Prometheus는?"
         → Prometheus "main" 발견
         │
t=17ms   Operator: Work Queue에 "monitoring/main" enqueue
         │
t=20ms   Operator: Reconcile("monitoring/main") 시작
         │
t=25ms   Operator: 모든 ServiceMonitor 수집 (기존 + 새로 추가된 것)
t=30ms   Operator: scrape_config 전체 재생성
t=35ms   Operator: Secret 업데이트 (새 scrape_config 포함)
         │
t=40ms   kubelet: Secret 변경 → Pod의 volume 업데이트
         │
t=50ms   config-reloader: 파일 변경 감지
t=55ms   config-reloader: POST http://localhost:9090/-/reload
         │
t=60ms   Prometheus: 새 설정 로드 완료
         │
t=90ms   Prometheus: 새 타겟 디스커버리 시작
         │
t=120ms  Prometheus: 첫 번째 스크래핑 실행
         │
         ▼
         새 서비스의 메트릭 수집 시작!
```

개발팀이 ServiceMonitor 하나만 생성하면, Prometheus 설정 파일을 직접 수정하거나 재배포할 필요 없이 자동으로 모니터링이 시작됩니다. 기존에 수동으로 prometheus.yml을 수정하고 ConfigMap을 교체하고 reload를 트리거하던 과정이 모두 자동화되는 것입니다.

## Operator 패턴의 설계 원칙

전체 내용을 관통하는 설계 원칙 세 가지를 정리합니다.

### Desired State Declaration

사용자는 "Prometheus가 어떤 상태여야 하는지"만 선언합니다. "어떻게 그 상태를 만들지"는 Operator의 책임입니다.

```
사용자가 선언하는 것:            Operator가 처리하는 것:
"replicas: 3"            →     StatefulSet 생성, Pod 관리
"retention: 15d"         →     Prometheus 설정 파일 생성
"serviceMonitorSelector" →     scrape_config 자동 생성/갱신
```

이것은 Kubernetes의 Declarative Model을 애플리케이션 도메인 수준으로 확장한 것입니다. Kubernetes가 "Pod 3개를 유지해라"를 선언적으로 처리하는 것처럼, Operator는 "Prometheus 서버를 이 설정으로 운영해라"를 선언적으로 처리합니다.

### Level-triggered Reconciliation

이전 글에서 다뤘던 것처럼, Operator도 Edge-triggered(이벤트 기반)가 아닌 **Level-triggered(상태 기반)** 방식으로 동작합니다. Reconcile 함수는 "무엇이 변경되었는가"가 아니라 "현재 상태와 원하는 상태의 차이가 무엇인가"를 계산합니다.

이 원칙 덕분에 Operator Pod가 일시적으로 다운되었다가 복구되어도, Reconcile이 다시 실행되면 현재 상태를 점검하고 필요한 조치를 수행합니다. 이벤트를 놓쳤을까 걱정할 필요가 없습니다.

### Single Writer Principle

각 리소스의 특정 필드는 **하나의 Controller만 수정** 해야 합니다. Prometheus Operator가 생성한 StatefulSet의 spec을 사용자가 직접 수정하면 어떻게 될까요? 다음 Reconcile에서 Operator가 원래 상태로 되돌립니다. 이것이 의도된 동작입니다.

```
올바른 경로:
  사용자 → Prometheus CR 수정 → Operator Reconcile → StatefulSet 업데이트

잘못된 경로 (drift 발생):
  사용자 → StatefulSet 직접 수정 → 다음 Reconcile에서 원복됨
```

변경은 반드시 Prometheus CR을 통해서만 이루어져야 합니다. 이 원칙을 지켜야 Operator가 일관된 상태를 유지할 수 있습니다.

## 정리

Kubernetes Operator는 CRD로 도메인 특화 API를 정의하고, Custom Controller로 운영 자동화 로직을 구현하는 패턴입니다. Prometheus Operator를 통해 살펴본 핵심 동작을 요약하면 다음과 같습니다.

| 구성 요소 | 역할 | Prometheus Operator 예시 |
|----------|------|------------------------|
| CRD | API 확장, 새 리소스 타입 등록 | Prometheus, ServiceMonitor, PrometheusRule 등 |
| Custom Controller | Reconcile 루프로 desired state 실현 | Prometheus CR → StatefulSet, ConfigMap 등 생성 |
| Informer | 여러 리소스의 변경을 효율적으로 감지 | ServiceMonitor 변경 → Prometheus CR Reconcile 트리거 |
| OwnerReference | 리소스 간 소유 관계, 자동 정리 | Prometheus 삭제 → 하위 리소스 Cascading Delete |
| Finalizer | 삭제 전 외부 리소스 정리 보장 | 외부 스토리지 정리 후 삭제 허용 |
| Config Reloader | 설정 변경 시 무중단 반영 | Secret 변경 → Prometheus /-/reload 호출 |

Operator 패턴의 진정한 가치는 **운영 지식의 코드화** 입니다. Prometheus를 안정적으로 운영하기 위해 알아야 할 StatefulSet 구성, 스토리지 관리, 설정 생성, 무중단 reload 등의 노하우가 모두 코드로 구현되어, 사용자는 원하는 상태를 YAML로 선언하기만 하면 됩니다.

## References

- [Kubernetes Operator Pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)
- [Prometheus Operator Documentation](https://prometheus-operator.dev/docs/prologue/introduction/)
- [Prometheus Operator API Reference](https://prometheus-operator.dev/docs/operator/api/)
- [controller-runtime: The Kubebuilder Book](https://book.kubebuilder.io/)
