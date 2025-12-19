---
layout: single
title: "Redis Sentinel vs Redis Cluster"
date: 2025-12-19 00:00:00 +0000
categories: infrastructure
tags: [redis, sentinel, cluster, high-availability, architecture, distributed-system, sharding]
excerpt: "Redis Sentinel과 Redis Cluster의 아키텍처 차이점, 노드 구성 전략, 그리고 16384 해시 슬롯의 비밀까지 상세히 알아봅니다."
---

## 들어가며

Redis는 인메모리 데이터 구조 저장소로 캐싱, 세션 관리, 메시지 브로커 등 다양한 용도로 활용됩니다. 프로덕션 환경에서 Redis를 운영할 때 가장 중요한 고려사항은 **고가용성(High Availability)**과 **확장성(Scalability)**입니다.

Redis는 이를 위해 두 가지 주요 솔루션을 제공합니다:
- **Redis Sentinel**: Master-Replica 복제 + 자동 장애조치
- **Redis Cluster**: 샤딩 기반 분산 시스템 + 고가용성

이 글에서는 두 솔루션의 아키텍처, 컴포넌트 구성, 노드 배치 전략을 비교하고, Redis Cluster가 왜 16384개의 해시 슬롯을 사용하는지 그 이유까지 살펴보겠습니다.

## Redis Sentinel

### 아키텍처

- **목적**: 고가용성 제공
- **구조**: Master-Replica 복제 + 독립적인 Sentinel 프로세스
- **데이터 분산**: 없음 (모든 데이터가 Master에 존재, Replica는 Master의 데이터를 복제)

### 컴포넌트 구성

#### 1. Redis 인스턴스

- **Master 1대**: 읽기/쓰기 처리
- **Replica N대**: Master 데이터 복제, 읽기 전용

#### 2. Sentinel 프로세스

- **최소 3대 권장** (quorum 때문에 1대가 죽어도 2대의 합의가 필요)
- Master 모니터링 및 health check
- 장애 감지 시 자동 failover 수행
- Replica를 새 Master로 승격
- 클라이언트에게 새 Master 정보 제공

### 노드 구성 예시

Redis 공식 문서에서 Sentinel이 가용성을 보장하는 여러 예시를 잘 들어주고 있습니다. 여기서는 두 가지 예시만 살펴보겠습니다.

#### 예시 1: 노드 3대로 Redis, Sentinel 동시 구성

```
       +----+
       | M1 |
       | S1 |
       +----+
          |
+----+    |    +----+
| R2 |----+----| R3 |
| S2 |         | S3 |
+----+         +----+

Configuration: quorum = 2
```

가장 간단한 셋업으로 가용성을 보장하는 최소 구성에 해당합니다. 첫 번째 노드가 죽는 경우, S2, S3가 합의하여 R2를 M2로 승격시키고, Redis 기능이 정상적으로 동작하게 됩니다.

이 상태에서 2번 노드가 또 죽게 되면, 그대로 장애가 발생하지만 1번 노드가 그 전에 복귀된다면, 다시 가용성을 보장하는 형태가 됩니다.

#### 예시 2: Master 1 + Replica 1 + Sentinel 3

```
            +----+         +----+
            | M1 |----+----| R1 |
            |    |    |    |    |
            +----+    |    +----+
                      |
         +------------+------------+
         |            |            |
         |            |            |
      +----+        +----+      +----+
      | C1 |        | C2 |      | C3 |
      | S1 |        | S2 |      | S3 |
      +----+        +----+      +----+

      Configuration: quorum = 2
```

이 경우, Sentinel의 quorum이 2이므로 Sentinel 1대 장애가 나도 시스템에 영향이 없습니다. 또한, Master에 장애가 발생하더라도 Replica가 즉시 Master로 승격되고 failover에 성공합니다.

이처럼 Sentinel과 Redis 인스턴스의 분리로 **장애 도메인이 겹치지 않는다**는 점에서 의미가 있습니다. Redis 인스턴스 장애 시에 대응도 빠르고 예측하기 어려운 물리적 장애에 대응하기 좋다는 점에서 의미가 있습니다.

### Sentinel의 한계

하지만, Redis에 메모리 full과 같은 에러가 발생하는 경우, 장애 후 승격되더라도 부하가 또다시 Redis 인스턴스에 발생하게 되고 다시 Redis 인스턴스에 장애가 발생하면 결국 장애가 발생합니다.

결국 이 경우 해결책은:
- 메모리 제한을 잘 설정
- Eviction policy 및 eviction 모니터링
- **수평 확장을 위해 Redis Cluster 고려**

## Redis Cluster

### 아키텍처

- **목적**: 수평 확장 + 고가용성
- **구조**: 샤딩 기반 분산 시스템
- **데이터 분산**: 총 16384개 해시 슬롯으로 데이터 분산

### 컴포넌트 구성

#### 1. Redis 노드 (단일 프로세스)

- **Master 노드**: 특정 해시 슬롯 담당, 읽기-쓰기가 분산됨
- **Replica 노드**: 각 Master의 복제본
- **각 노드가 클러스터 관리 기능 내장**
  - 노드 간 Gossip 프로토콜로 상태 공유
  - 자동 failover (과반수 투표)

### 노드 구성

```
┌─────────────────────────────────────────────────────────────────┐
│                      Redis Cluster (6 Nodes)                    │
│                                                                 │
│  Node 1                Node 2                Node 3            │
│  ┌──────────┐          ┌──────────┐          ┌──────────┐      │
│  │ Master A │          │ Master B │          │ Master C │      │
│  │          │          │          │          │          │      │
│  │ Slot:    │          │ Slot:    │          │ Slot:    │      │
│  │ 0-5461   │          │5462-10922│          │10923-    │      │
│  │          │          │          │          │ 16383    │      │
│  └────┬─────┘          └────┬─────┘          └────┬─────┘      │
│       │                     │                     │            │
│       │ replicates          │ replicates          │ replicates │
│       │                     │                     │            │
│       ↓                     ↓                     ↓            │
│  ┌──────────┐          ┌──────────┐          ┌──────────┐      │
│  │Replica C │          │Replica A │          │Replica B │      │
│  │          │          │          │          │          │      │
│  │ Slot:    │          │ Slot:    │          │ Slot:    │      │
│  │10923-    │          │ 0-5461   │          │5462-10922│      │
│  │ 16383    │          │          │          │          │      │
│  └──────────┘          └──────────┘          └──────────┘      │
│  Node 4                Node 5                Node 6            │
│                                                                 │
│  Gossip Protocol: 모든 노드가 서로 통신                          │
│  ←─────────────────────────────────────────────────────────→   │
└─────────────────────────────────────────────────────────────────┘
```

- 각 Master는 서로 다른 해시 슬롯 담당
- 각 Master의 Replica는 다른 노드에 배치
- 모든 노드가 Gossip으로 상태 공유
- **Cluster Bus**: 16379 포트 사용

### 수평 확장의 장점

Redis Cluster는 각 Master가 읽기-쓰기 부하를 나눠 갖는 샤드 구조입니다.

**해시 슬롯**은 키가 아니라 **버킷의 개념**으로 각 슬롯은 무한정의 키를 가질 수 있습니다.

Sentinel은 위에서 언급한 것처럼 일정량의 부하가 들어와 장애가 발생하기 시작하면, Replica가 Master로 승격되고 failover가 발생해도 연속 장애가 발생할 가능성이 있습니다.

이 경우, 노드의 메모리를 증가시키는 **scale up**이 이루어져야 하지만, 여전히 불안하고 운영 중이라면 다운타임이 발생할 수 있습니다.

하지만, Cluster의 경우 **Master-Replica 노드를 각각 추가하는 수평 확장**이 가능합니다.

Master-Replica가 동시에 장애가 발생하는 경우, 혹은 Master에 장애 발생 후, Replica가 Master로 승격 전에 또다시 Replica에 장애가 발생하는 게 아니라면 서비스에 문제가 없습니다.

## 왜 슬롯은 16384개일까?

이 이유는 이미 10년 전에 Redis GitHub에 동일한 질문이 이슈로 올라왔고, Redis 개발자가 답변을 남겼습니다.

### Gossip Protocol 패킷 크기

Redis Cluster에서는 서로의 Health Check를 위해 **Gossip 프로토콜**을 사용합니다.

모든 노드가 서로에게 heartbeat를 전송하고, 각 heartbeat에 슬롯 매핑 정보가 포함됩니다.

```
# Heartbeat 패킷 구조
┌────────────────────────────────────────┐
│         Gossip Heartbeat 패킷          │
├────────────────────────────────────────┤
│ Header: 64 bytes                       │
│ - 노드 ID, IP, Port, 상태 등           │
├────────────────────────────────────────┤
│ Slot Bitmap: 2048 bytes (2KB)          │
│ - 각 비트 = 1개 슬롯 담당 여부          │
│ - 예: 00110011... (이진수)             │
│   Slot 0: 담당 안함 (0)                │
│   Slot 1: 담당 안함 (0)                │
│   Slot 2: 담당함 (1)                   │
│   Slot 3: 담당함 (1)                   │
├────────────────────────────────────────┤
│ Gossip Section: 가변                   │
│ - 다른 노드들 정보                      │
└────────────────────────────────────────┘
```

위 예시처럼 각 슬롯을 해당 노드가 담당하는지 여부를 **bitmap**으로 표시하게 되는데 16384 슬롯은 딱 2KB가 됩니다.

```
16384 bits = 2048 bytes = 2KB
```

### 네트워크 대역폭 계산

6개 노드 기준으로 서로 매초 heartbeat를 보낸다고 가정하면:
- 총 30개의 heartbeat가 초당 발생
- 대역폭: **60KB/sec**

만약 슬롯의 bitmap 크기가 **65536 bit**일 경우, 8KB로 4배 정도 증가해 네트워크 부하가 그만큼 증가하게 됩니다.

노드가 증가할 경우, 이 숫자도 선형이 아니라 더 급하게 증가하기 때문에 **2KB 정도로 형성하는 게 적당하다**고 판단했다고 합니다.

### 추가 고려사항

Redis 개발자의 답변에 따르면:
1. **노드 수 제한**: Redis Cluster는 1000개 노드까지 권장 (실제로는 그보다 훨씬 적게 사용)
2. **재샤딩 오버헤드**: 슬롯 수가 많을수록 재샤딩 시 메타데이터 전송량 증가
3. **메모리 효율성**: 각 노드가 유지해야 하는 슬롯 매핑 정보 최소화

## Sentinel vs Cluster 선택 가이드

### Sentinel을 선택해야 하는 경우

- 데이터셋이 단일 노드 메모리에 수용 가능
- 읽기 성능 향상을 위한 Replica 스케일아웃만 필요
- 간단한 아키텍처 선호
- 자동 failover만 필요

### Cluster를 선택해야 하는 경우

- 데이터셋이 단일 노드 메모리를 초과
- 쓰기 성능도 수평 확장이 필요
- 높은 가용성과 확장성 모두 필요
- 트래픽이 지속적으로 증가하는 환경

## 결론

**Redis Sentinel**과 **Redis Cluster**는 각각 다른 문제를 해결하기 위해 설계되었습니다:

- **Sentinel**: 고가용성에 집중, 자동 failover를 통한 다운타임 최소화
- **Cluster**: 수평 확장 + 고가용성, 대규모 데이터와 트래픽 처리

프로덕션 환경에서는 데이터 크기, 트래픽 패턴, 가용성 요구사항을 종합적으로 고려하여 적절한 솔루션을 선택해야 합니다. 많은 경우 Sentinel로 시작하여, 확장성이 필요해지면 Cluster로 마이그레이션하는 전략이 효과적입니다.

## Reference

- [Redis: High availability with Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- [Redis: Scale with Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/#redis-cluster-configuration-parameters)
- [Redis GitHub Issue: Why 16384 slots?](https://github.com/redis/redis/issues/2576)
