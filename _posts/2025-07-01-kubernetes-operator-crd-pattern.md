---
layout: single
title: "Kubernetes Operator 패턴과 CRD(Custom Resource Definition)"
date: 2025-07-01 13:36:00 +0000
categories: [kubernetes]
tags: [kubernetes, operator, crd, controller]
excerpt: "Kubernetes Operator 패턴과 Custom Resource Definition(CRD)을 활용하여 복잡한 애플리케이션 운영을 자동화하는 방법을 알아봅니다."
---

Kubernetes는 컨테이너화된 워크로드를 관리하고 오케스트레이션하는 강력한 플랫폼입니다. 하지만 Kubernetes 자체는 모든 종류의 애플리케이션을 위한 복잡한 운영 로직을 내장하고 있지 않습니다. 이때 **Kubernetes Operator 패턴** 과 **Custom Resource Definition(CRD)** 이 Kubernetes의 기능을 확장하고 특정 애플리케이션의 운영을 자동화합니다.

<!--more-->

## Kubernetes Operator 패턴이란?

Kubernetes Operator는 **특정 애플리케이션의 도메인 지식(domain knowledge)을 캡슐화하고 자동화하는 소프트웨어 확장** 입니다. 사람이 수동으로 하던 애플리케이션 관리 작업을 코드로 구현하여 Kubernetes 클러스터에서 자동으로 수행하도록 합니다.

### 핵심 원리: Control Loop

Operator는 Kubernetes의 핵심 원리인 **제어 루프(Control Loop)** 를 따릅니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Operator Control Loop                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│    ┌─────────────┐    비교    ┌─────────────┐                   │
│    │ Desired     │◄─────────►│ Actual      │                   │
│    │ State (CR)  │           │ State       │                   │
│    └─────────────┘           └─────────────┘                   │
│           │                        ▲                           │
│           │                        │                           │
│           ▼                        │                           │
│    ┌─────────────────────────────────────────┐                 │
│    │           Reconciliation                │                 │
│    │  (차이가 있으면 Actual → Desired로 조정)  │                 │
│    └─────────────────────────────────────────┘                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| 단계 | 설명 | 예시 |
|------|------|------|
| Desired State | 사용자가 CR을 통해 정의하는 이상적인 상태 | "PostgreSQL 3개 인스턴스, 매일 새벽 2시 백업" |
| Actual State | 현재 클러스터에서 실행 중인 실제 상태 | 현재 2개 인스턴스만 실행 중 |
| Reconciliation | 두 상태의 차이를 감지하고 일치시키는 작업 | 1개 인스턴스 추가 생성 |

### 왜 Operator가 필요한가?

**복잡한 애플리케이션 관리 자동화**
- 데이터베이스(PostgreSQL, MySQL), 메시지 큐(Kafka), 캐싱 시스템(Redis) 등 상태 저장(stateful) 애플리케이션은 배포, 스케일링, 백업, 복구, 업그레이드 등 복잡한 운영 작업이 필요합니다.
- Operator는 이러한 작업을 코드로 자동화하여 수동 개입을 최소화합니다.

**운영 지식의 코드화**
- 특정 애플리케이션에 대한 운영 지식(장애 복구 절차, 버전 업그레이드 방법)을 코드 형태로 Kubernetes에 통합합니다.

**Kubernetes API 확장**
- 마치 Kubernetes 내장 리소스(Pod, Deployment, Service)처럼 특정 애플리케이션을 관리할 수 있도록 API를 확장합니다.

**Day-2 Operations 자동화**
- 배포 후의 지속적인 운영(모니터링, 로깅, 스케일링, 복구, 업그레이드)을 자동화합니다.

### 주요 사용 사례

| 분야 | 예시 |
|------|------|
| 데이터베이스 | PostgreSQL, MySQL, Cassandra 클러스터의 배포, 복제, 백업, 복구 자동화 |
| 메시지 큐 | Apache Kafka, RabbitMQ 클러스터의 설치, 설정, 스케일링 |
| 모니터링 | Prometheus, Grafana 등 모니터링 시스템의 배포 및 설정 |
| CI/CD | Jenkins, Argo CD 등 CI/CD 도구의 관리 |

---

## Custom Resource Definition(CRD)란?

**Custom Resource Definition(CRD)** 은 Kubernetes API를 확장하여 **사용자 정의 리소스 타입을 정의할 수 있도록 하는 메커니즘** 입니다. Kubernetes에 기본적으로 제공되지 않는 새로운 종류의 객체를 생성할 수 있게 해줍니다.

### CRD의 역할

**새로운 API 엔드포인트 생성**
- CRD를 생성하면 해당 리소스 타입에 대한 새로운 API 엔드포인트가 Kubernetes API 서버에 추가됩니다.
- 예: `kind: PostgreSQL` CRD를 정의하면 `kubectl get postgresqls` 명령으로 조회 가능

**사용자 정의 객체의 스키마 정의**
- CRD는 YAML 형식으로 작성되며, Custom Resource(CR)가 어떤 필드와 구조를 가질지 정의합니다.
- Kubernetes가 Pod, Deployment 등 내장 리소스를 정의하는 방식과 유사합니다.

**Kubernetes의 확장성**
- CRD를 통해 Kubernetes는 특정 애플리케이션이나 도메인에 특화된 개념을 내장 리소스처럼 다룰 수 있습니다.

### CRD와 Operator의 관계

```
┌─────────────────────────────────────────────────────────────────┐
│                  CRD와 Operator의 관계                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│    CRD (설계도)          CR (인스턴스)        Operator (로직)    │
│    ┌──────────┐         ┌──────────┐        ┌──────────────┐   │
│    │PostgreSQL│         │my-db-cr  │        │PostgreSQL    │   │
│    │  스키마   │ ──────► │ replicas │ ─────► │  Operator    │   │
│    │  정의    │  정의에   │    : 3   │ 감지    │ (Controller) │   │
│    └──────────┘  따라    └──────────┘        └──────────────┘   │
│                                                    │            │
│                                                    ▼            │
│                                             실제 리소스 생성    │
│                                             (Pod, PVC, etc.)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **CRD** 는 Operator가 관리할 "대상"을 정의합니다.
- **Operator** 는 CRD에 정의된 "원하는 상태"를 "실제 상태"로 만들기 위한 "로직"을 구현합니다.

---

## 예시: PostgreSQL Operator

PostgreSQL 데이터베이스를 관리하는 Operator를 만든다고 가정해 봅시다.

### 1. CRD 정의

`PostgreSQL`이라는 이름의 CRD를 정의합니다. 이 CRD는 PostgreSQL 데이터베이스의 버전, 인스턴스 수, 백업 설정, 스토리지 크기 등을 `spec` 필드에 포함합니다.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: postgresqls.database.example.com
spec:
  group: database.example.com
  names:
    kind: PostgreSQL
    plural: postgresqls
    singular: postgresql
    shortNames:
      - pg
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                version:
                  type: string
                replicas:
                  type: integer
                storage:
                  type: string
                backup:
                  type: object
                  properties:
                    enabled:
                      type: boolean
                    schedule:
                      type: string
```

### 2. Custom Resource(CR) 생성

사용자는 위에서 정의한 CRD 스키마에 따라 실제 PostgreSQL 인스턴스를 요청하는 CR을 생성합니다.

```yaml
apiVersion: database.example.com/v1
kind: PostgreSQL
metadata:
  name: my-postgres
  namespace: production
spec:
  version: "15.2"
  replicas: 3
  storage: "50Gi"
  backup:
    enabled: true
    schedule: "0 2 * * *"  # 매일 새벽 2시
```

### 3. Operator(Controller) 동작

Operator는 CR의 변화를 감지하고 다음 작업을 자동으로 수행합니다.

```
┌──────────────────────────────────────────────────────────────┐
│                   Operator 동작 흐름                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Watch: PostgreSQL CR 변화 감지                            │
│     └─► my-postgres CR 생성됨 (replicas: 3)                  │
│                                                              │
│  2. Reconcile: 현재 상태 확인                                 │
│     └─► StatefulSet 없음, PVC 없음                            │
│                                                              │
│  3. Create: 필요한 리소스 생성                                │
│     ├─► StatefulSet (replicas: 3)                            │
│     ├─► PersistentVolumeClaim (50Gi x 3)                     │
│     ├─► Service (ClusterIP, Headless)                        │
│     ├─► ConfigMap (PostgreSQL 설정)                          │
│     └─► CronJob (백업 스케줄)                                 │
│                                                              │
│  4. Monitor: 지속적인 상태 감시                               │
│     ├─► Pod 장애 발생 시 자동 복구                            │
│     ├─► replicas 변경 시 스케일 조정                          │
│     └─► 백업 실패 시 재시도 및 알림                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 요약

| 개념 | 설명 | 역할 |
|------|------|------|
| CRD | Kubernetes API를 확장하여 새로운 리소스 타입을 정의 | 설계도/명세서 |
| CR | CRD에 의해 정의된 설계도에 따라 생성되는 실제 객체 | 인스턴스 |
| Operator | CR의 변화를 감지하고 원하는 상태를 클러스터에 반영 | 자동화된 컨트롤러 |

이러한 Operator 패턴과 CRD는 Kubernetes를 특정 애플리케이션의 플랫폼으로 확장하고, 복잡한 운영 작업을 자동화하는 데 핵심적인 역할을 합니다.

---

## 참고

- [Kubernetes Operator 공식 문서](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Operator SDK](https://sdk.operatorframework.io/)
- [Kubebuilder](https://book.kubebuilder.io/)
