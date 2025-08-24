---
categories: kubernetes
date: 2025-07-01 13:36:00 +0000
excerpt: Kubernetes는 컨테이너화된 워크로드를 관리하고 오케스트레이션하는 강력한 플랫폼입니다. 하지만 Kubernetes 자체는 모든
  종류의 애플리케이션을 위한 복잡한 운영 로직을 내장하고 있지는 않습니다. 이때 Kubernetes Operator 패턴과 Custom...
layout: post
notion_id: 223eef64-a1ca-809e-b68c-c87140c793c7
notion_url: https://www.notion.so/Kubernetes-Operator-CRD-Custom-Resource-Definition-223eef64a1ca809eb68cc87140c793c7
tags:
- tech
- kubernetes
- k8s
title: Kubernetes Operator 패턴과 CRD(Custom Resource Definition)
---

Kubernetes는 컨테이너화된 워크로드를 관리하고 오케스트레이션하는 강력한 플랫폼입니다. 하지만 Kubernetes 자체는 모든 종류의 애플리케이션을 위한 복잡한 운영 로직을 내장하고 있지는 않습니다. 이때 **Kubernetes Operator 패턴**과 **Custom Resource Definition (CRD)**이 등장하여 Kubernetes의 기능을 확장하고 특정 애플리케이션의 운영을 자동화할 수 있도록 돕습니다.


<!--more-->
# Kubernetes Operator 패턴이란?

Kubernetes Operator는 **특정 애플리케이션의 도메인 지식(domain knowledge)을 캡슐화하고 자동화하는 소프트웨어 확장**입니다. 쉽게 말해, 사람이 수동으로 하던 애플리케이션 관리 작업을 코드로 구현하여 Kubernetes 클러스터에서 자동으로 수행하도록 하는 것입니다.

### **핵심 원리 (Control Loop)**

Operator는 Kubernetes의 핵심 원리인 **"제어 루프(Control Loop)"**를 따릅니다.

1. **Desired State (원하는 상태):** 사용자가 Custom Resource (CR)를 통해 정의하는 애플리케이션의 이상적인 상태입니다. 예를 들어, "PostgreSQL 데이터베이스 인스턴스 3개가 필요하고, 백업은 매일 새벽 2시에 실행되어야 한다"와 같은 정보입니다.
1. **Actual State (실제 상태):** 현재 Kubernetes 클러스터에서 실행 중인 애플리케이션의 실제 상태입니다.
1. **Reconciliation (조정):** Operator는 지속적으로 Desired State와 Actual State를 비교하고, 둘 사이에 차이가 있을 경우 Actual State를 Desired State와 일치시키기 위한 작업을 수행합니다. 예를 들어, PostgreSQL 인스턴스가 2개만 있다면 1개를 더 생성하고, 백업이 안 되어 있다면 백업 작업을 시작합니다.
### **왜 Operator가 필요한가?**

- **복잡한 애플리케이션 관리 자동화:** 데이터베이스 (PostgreSQL, MySQL), 메시지 큐 (Kafka), 캐싱 시스템 (Redis)과 같은 상태 저장(stateful) 애플리케이션은 배포, 스케일링, 백업, 복구, 업그레이드 등 복잡한 운영 작업이 필요합니다. Operator는 이러한 작업을 코드로 자동화하여 수동 개입을 최소화합니다.
- **운영 지식의 코드화:** 특정 애플리케이션에 대한 깊은 운영 지식 (예: 장애 발생 시 복구 절차, 특정 버전 업그레이드 방법)을 코드 형태로 Kubernetes에 통합합니다.
- **Kubernetes API 확장:** 마치 Kubernetes 내장 리소스(Pod, Deployment, Service 등)처럼 특정 애플리케이션을 관리할 수 있도록 Kubernetes API를 확장합니다.
- **사람의 실수 감소 및 안정성 향상:** 수동 작업에서 발생할 수 있는 실수를 줄이고, 일관되고 신뢰할 수 있는 방식으로 애플리케이션을 관리합니다.
- **Day-2 Operations 자동화:** 배포 후의 지속적인 운영 (모니터링, 로깅, 스케일링, 복구, 업그레이드 등)을 자동화하여 운영 효율성을 높입니다.
**주요 사용 사례:**

- **데이터베이스 관리:** PostgreSQL, MySQL, Cassandra 등 데이터베이스 클러스터의 배포, 복제, 백업, 복구, 업그레이드 자동화.
- **메시지 큐 시스템:** Apache Kafka, RabbitMQ 등 메시지 큐 클러스터의 설치, 설정, 스케일링, 모니터링.
- **모니터링 스택:** Prometheus, Grafana 등 모니터링 시스템의 배포 및 설정.
- **CI/CD 파이프라인:** Jenkins, Argo CD 등 CI/CD 도구의 관리.
- **복잡한 SaaS 애플리케이션:** 특정 서비스형 소프트웨어(SaaS)의 배포 및 라이프사이클 관리.
## Custom Resource Definition (CRD)란?

- *Custom Resource Definition (CRD)*은 Kubernetes API를 확장하여 **사용자 정의 리소스 타입(Custom Resource Type)을 정의할 수 있도록 하는 메커니즘**입니다. 즉, Kubernetes에 기본적으로 제공되지 않는 새로운 종류의 객체를 생성할 수 있게 해줍니다.
### **CRD의 역할**

- **새로운 API 엔드포인트 생성:** CRD를 생성하면 해당 리소스 타입에 대한 새로운 API 엔드포인트가 Kubernetes API 서버에 추가됩니다. 예를 들어, `kind: PostgreSQL`이라는 CRD를 정의하면 `kubectl get postgresqls`와 같이 해당 리소스를 조회할 수 있게 됩니다.
- **사용자 정의 객체의 스키마 정의:** CRD는 YAML 형식으로 작성되며, 사용자가 정의할 Custom Resource (CR)가 어떤 필드(spec)와 구조를 가질지 정의합니다. 이는 Kubernetes가 Pod, Deployment 등 내장 리소스를 정의하는 방식과 유사합니다.
- **Kubernetes의 확장성:** CRD를 통해 Kubernetes는 특정 애플리케이션이나 도메인에 특화된 개념을 내장 리소스처럼 다룰 수 있게 되어, 플랫폼의 확장성이 크게 향상됩니다.
### **CRD와 Operator의 관계**

Operator와 CRD는 뗄 수 없는 관계입니다.

- **CRD는 Operator가 관리할 "대상"을 정의합니다.** Operator는 특정 CRD에 의해 정의된 Custom Resource (CR)의 변화를 감지하고, 그 변화에 따라 실제 클러스터의 상태를 조정합니다.
- **Operator는 CRD에 정의된 "원하는 상태"를 "실제 상태"로 만들기 위한 "로직"을 구현합니다.** CRD는 단순히 데이터 구조를 정의할 뿐, 그 데이터에 따라 어떤 작업을 수행할지는 Operator (컨트롤러)가 담당합니다.
### 예시

PostgreSQL 데이터베이스를 관리하는 Operator를 만든다고 가정해 봅시다.

1. **CRD 정의:** `PostgreSQL`이라는 이름의 CRD를 정의합니다. 이 CRD는 PostgreSQL 데이터베이스의 버전, 인스턴스 수, 백업 설정, 스토리지 크기 등 사용자가 설정하고 싶은 항목들을 `spec` 필드에 포함하도록 스키마를 정의합니다.
1. **Custom Resource (CR) 생성:** 사용자는 위에서 정의한 `PostgreSQL` CRD의 스키마에 따라 실제 PostgreSQL 데이터베이스 인스턴스를 요청하는 CR을 생성합니다.
1. **Operator (컨트롤러) 동작:**
**요약하자면:**

- **CRD (Custom Resource Definition)**: Kubernetes API를 확장하여 새로운 리소스 타입을 정의하는 **설계도** 또는 **명세서**입니다.
- **Custom Resource (CR)**: CRD에 의해 정의된 설계도에 따라 생성되는 **실제 객체 인스턴스**입니다.
- **Operator**: 특정 CRD의 변화를 감지하고, CR에 정의된 원하는 상태를 실제 클러스터에 반영하기 위한 **자동화된 컨트롤러**입니다. 특정 애플리케이션의 운영 노하우를 코드로 구현한 것입니다.
이러한 Operator 패턴과 CRD는 Kubernetes를 특정 애플리케이션의 플랫폼으로 확장하고, 복잡한 운영 작업을 자동화하는 데 매우 강력하고 핵심적인 역할을 합니다.

## 레퍼런스

[https://kubernetes.io/docs/concepts/extend-kubernetes/operator/](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)


---

*Originally published in [Notion](https://www.notion.so/Kubernetes-Operator-CRD-Custom-Resource-Definition-223eef64a1ca809eb68cc87140c793c7) on July 01, 2025*