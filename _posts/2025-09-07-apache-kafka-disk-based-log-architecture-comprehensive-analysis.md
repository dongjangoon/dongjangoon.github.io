---
layout: post
title: "Apache Kafka 아키텍처 분석: 디스크 기반 로그 구조와 메시지 브로커의 설계 철학"
date: 2025-09-07 14:00:00 +0000
categories: [streaming, messaging]
tags: [kafka, message-broker, distributed-systems, log-architecture, rabbitmq, event-streaming, high-throughput]
excerpt: "Kafka의 디스크 기반 로그 구조가 어떻게 고처리량을 달성하는지 분석하고, RabbitMQ와의 라우팅 및 복제 아키텍처를 비교합니다."
---

## 들어가며

Apache Kafka는 현대 분산 시스템에서 가장 널리 사용되는 스트리밍 플랫폼 중 하나입니다. 전통적인 메시지 큐 시스템과는 완전히 다른 접근법을 통해 **초당 수백만 건의 메시지 처리**라는 놀라운 성능을 달성했습니다.

이 글에서는 Kafka의 핵심인 **디스크 기반 로그 구조**를 깊이 분석하고, RabbitMQ와의 아키텍처 비교를 통해 각 시스템의 설계 철학을 살펴보겠습니다.

## Kafka의 저장소 아키텍처: 디스크 기반 로그 구조

### 로그 중심 아키텍처의 핵심

Kafka의 가장 독특한 특징은 **로그 자체가 기본 저장소**라는 점입니다. 별도의 데이터베이스나 인메모리 구조 없이, 디스크의 로그 파일이 모든 데이터를 관리합니다.

#### 1. 순차 로그 파일 구조

```
/kafka-logs/
├── topic-0/
│   ├── 00000000000000000000.log  # 파티션 0의 로그 파일
│   ├── 00000000000000000000.index
│   └── 00000000000000000000.timeindex
├── topic-1/
│   ├── 00000000000000000000.log  # 파티션 1의 로그 파일
│   └── ...
└── topic-2/
    └── ...
```

**주요 특징:**
- **Append-Only**: 기존 데이터 수정 없이 항상 끝에 추가
- **파티션별 독립**: 각 파티션마다 별도 로그 파일 세트
- **순차 쓰기**: 디스크에서 가장 빠른 I/O 패턴 활용

#### 2. 순차 쓰기 vs 랜덤 쓰기의 성능 차이

**순차 쓰기 (Kafka 방식)**:
- 디스크 헤드 이동 최소화
- 연속된 블록에 데이터 저장
- **처리량**: ~600MB/s (일반적인 SATA SSD 기준)

**랜덤 쓰기 (전통적 데이터베이스)**:
- 인덱스 기반 특정 위치 업데이트
- B+ 트리, LSM 트리 등 복잡한 구조
- **처리량**: ~100MB/s (동일 하드웨어 기준)

```bash
# 순차 쓰기 성능 테스트
dd if=/dev/zero of=sequential.dat bs=1M count=1000 oflag=direct
# 결과: 600 MB/s

# 랜덤 쓰기 성능 테스트  
fio --name=random-write --ioengine=libaio --rw=randwrite --bs=4k --size=1G
# 결과: ~100 MB/s
```

### WAL vs 로그 중심 아키텍처

#### 전통적인 데이터베이스의 WAL 패턴

```
클라이언트 요청
    ↓
WAL에 먼저 기록 (내구성 보장)
    ↓
실제 데이터 페이지에 반영
    ↓
체크포인트 및 WAL 정리
```

WAL은 **복구를 위한 보조 메커니즘**으로 사용됩니다.

#### Kafka의 로그 중심 아키텍처

```
메시지 수신
    ↓
로그 파일에 직접 append
    ↓
완료 (별도 WAL 불필요)
```

로그 파일 자체가 **기본이자 유일한 저장소**입니다.

## 왜 데이터베이스를 사용하지 않았을까?

### 1. 성능 최적화 관점

#### 높은 처리량 요구사항
- **목표**: 초당 수백만 건의 메시지 처리
- **병목 제거**: 데이터베이스 계층의 오버헤드 완전 제거
- **직접 I/O**: 파일 시스템과 직접 통신

#### OS 페이지 캐시 활용
```bash
# Kafka의 메모리 사용 패턴
# JVM 힙: 상대적으로 작게 설정 (2-4GB)
# OS 페이지 캐시: 대부분의 메모리 할당 (수십 GB)

# 일반적인 Kafka JVM 설정
export KAFKA_HEAP_OPTS="-Xmx2G -Xms2G"
```

Kafka는 JVM 힙 메모리를 최소화하고, OS 페이지 캐시를 최대한 활용합니다.

### 2. 메시지 브로커 특성에 최적화

#### 임시적 데이터 특성
```bash
# Kafka 보존 정책 설정 예시
log.retention.hours=168        # 7일 보관
log.retention.bytes=1073741824 # 1GB 제한
log.segment.bytes=1073741824   # 1GB 세그먼트
```

메시지는 **일정 시간 후 자동 삭제**되므로 복잡한 영속성 기능이 불필요합니다.

#### 단순한 데이터 모델
- **복잡한 쿼리 불필요**: SELECT, JOIN, INDEX 등 미지원
- **순차 읽기/쓰기만**: 메시지의 순차적 저장과 소비만 처리
- **스키마 관리 단순화**: 스키마 레지스트리로 별도 관리

### 3. 자연스러운 수평 확장

```
토픽: user-events (파티션 6개)
├── 파티션 0 → 브로커 1
├── 파티션 1 → 브로커 2  
├── 파티션 2 → 브로커 3
├── 파티션 3 → 브로커 1
├── 파티션 4 → 브로커 2
└── 파티션 5 → 브로커 3
```

각 파티션이 독립적으로 운영되어 **선형적 확장성**을 제공합니다.

## Kafka vs RabbitMQ: 라우팅 아키텍처 비교

### RabbitMQ: 중앙집중식 라우팅

#### Exchange 기반 라우팅 시스템

```
생산자 → Exchange → 바인딩 규칙 → 큐 → 소비자
```

**Exchange 타입별 라우팅**:
```bash
# Direct Exchange - 라우팅 키 완전 일치
rabbitmqctl declare exchange direct_logs direct

# Topic Exchange - 패턴 매칭
rabbitmqctl declare exchange topic_logs topic

# Fanout Exchange - 브로드캐스트
rabbitmqctl declare exchange logs fanout
```

#### 장점과 한계
**장점:**
- 복잡한 라우팅 규칙 지원
- 동적 바인딩 관리 가능
- 유연한 메시지 분배

**한계:**
- Exchange가 중앙 집중식 병목점
- 라우팅 계산 오버헤드
- 메타데이터 관리 복잡성

### Kafka: 분산형 직접 라우팅

#### 생산자 주도 라우팅

```java
// Kafka 생산자의 파티션 선택
Properties props = new Properties();
props.put("bootstrap.servers", "localhost:9092");
props.put("partitioner.class", "org.apache.kafka.clients.producer.internals.DefaultPartitioner");

Producer<String, String> producer = new KafkaProducer<>(props);

// 키 기반 파티션 선택 (해시 함수 사용)
producer.send(new ProducerRecord<>("user-events", userId, eventData));

// 명시적 파티션 지정
producer.send(new ProducerRecord<>("user-events", 2, userId, eventData));
```

#### 클라이언트 측 메타데이터 캐싱
```bash
# 생산자가 브로커로부터 메타데이터 요청
Request: MetadataRequest(topics=['user-events'])
Response: MetadataResponse(
  brokers=[
    {id=1, host='kafka-1', port=9092},
    {id=2, host='kafka-2', port=9092}
  ],
  partitions=[
    {topic='user-events', partition=0, leader=1},
    {topic='user-events', partition=1, leader=2}
  ]
)
```

**라우팅 과정:**
1. **메타데이터 캐싱**: 브로커-파티션 매핑 정보 로컬 저장
2. **파티션 선택**: 키 해시 또는 라운드 로빈
3. **직접 연결**: 해당 파티션의 리더 브로커에 직접 전송

## 복제 아키텍처: 푸시 vs 풀 모델

### RabbitMQ: 푸시 기반 동기 복제

#### 마스터-미러 동기화

```
1. 마스터 큐가 메시지 수신
2. 모든 미러 큐에 동시 푸시
3. 모든 미러의 ACK 대기
4. 전체 완료 후 생산자에게 응답
```

**설정 예시:**
```bash
# 미러 큐 정책 설정
rabbitmqctl set_policy ha-all "^ha\." '{"ha-mode":"all","ha-sync-mode":"automatic"}'
```

**특징:**
- **강한 일관성**: 모든 복제본 동기화 보장
- **즉시 복제**: 메시지 도착과 동시에 복제 시작
- **성능 제약**: 가장 느린 미러가 전체 성능 결정

### Kafka: 풀 기반 비동기 복제 + ISR

#### ISR (In-Sync Replicas) 메커니즘

```java
// Kafka 복제 설정
Properties props = new Properties();
props.put("acks", "all");  // ISR 모든 멤버의 확인 대기
props.put("replication.factor", "3");  // 복제본 3개
props.put("min.in.sync.replicas", "2");  // 최소 ISR 크기
```

#### 동적 ISR 관리

```bash
# ISR 상태 확인
kafka-topics.sh --describe --topic user-events --bootstrap-server localhost:9092

# 출력 예시:
# Topic: user-events  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2
```

**ISR 동작 과정:**
1. **정상 상태**: ISR = [1, 2, 3] (모든 복제본 동기화)
2. **팔로워 지연**: 브로커 3이 `replica.lag.time.max.ms` 초과
3. **ISR 조정**: ISR = [1, 2] (브로커 3 제외)
4. **성능 유지**: 느린 복제본에 영향받지 않음

#### 풀 모델의 배치 최적화

```java
// 팔로워 브로커의 fetch 요청
FetchRequest fetchRequest = new FetchRequest.Builder()
    .setMaxWaitMs(500)          // 최대 대기 시간
    .setMinBytes(1024)          // 최소 배치 크기
    .setMaxBytes(1024 * 1024)   // 최대 배치 크기
    .build();
```

배치 처리를 통해 네트워크 효율성을 극대화합니다.

## 성능 및 확장성 비교

### 처리량 특성

| 메트릭 | RabbitMQ | Kafka |
|---|---|---|
| **순차 처리량** | ~20K msg/sec | ~2M msg/sec |
| **복제 오버헤드** | 복제본 수에 반비례 | 복제본 수와 독립적 |
| **메모리 사용** | 인메모리 큐잉 | OS 페이지 캐시 |
| **디스크 I/O** | 랜덤 액세스 | 순차 액세스 |

### 확장성 패턴

#### RabbitMQ: 수직 확장 중심
```bash
# 클러스터 노드 추가
rabbitmqctl join_cluster rabbit@node1

# 하지만 Exchange는 여전히 중앙집중식 병목
```

#### Kafka: 수평 확장 최적화
```bash
# 파티션 증가를 통한 확장
kafka-topics.sh --alter --topic user-events --partitions 12 --bootstrap-server localhost:9092

# 브로커 추가 후 파티션 재분배
kafka-reassign-partitions.sh --bootstrap-server localhost:9092 --reassignment-json-file expand.json --execute
```

## CAP 정리 관점에서의 트레이드오프

### RabbitMQ: CP (일관성 + 분할 내성)

```bash
# 네트워크 분할 시 동작
# 마스터와 미러 간 연결 끊김 → 전체 큐 사용 불가
# 강한 일관성 보장하지만 가용성 희생
```

**적합한 사용 사례:**
- 금융 거래 시스템
- 주문 처리 워크플로우
- 메시지 손실이 치명적인 시스템

### Kafka: AP (가용성 + 분할 내성)

```bash
# 네트워크 분할 시 동작
# ISR 크기 조정 → 사용 가능한 복제본으로 서비스 지속
# 최종 일관성 모델 → 높은 가용성 보장
```

**적합한 사용 사례:**
- 로그 수집 및 분석
- 이벤트 스트리밍 파이프라인
- 실시간 데이터 처리

## 실무 운영 고려사항

### Kafka 클러스터 설정 최적화

```bash
# server.properties 주요 설정
num.network.threads=8
num.io.threads=16
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400

# 로그 보존 정책
log.retention.hours=168
log.segment.bytes=1073741824
log.cleanup.policy=delete

# 복제 설정
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
```

### 모니터링 주요 메트릭

```bash
# JMX를 통한 주요 메트릭 수집
kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec
kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec
kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions
kafka.server:type=RequestMetrics,name=RequestsPerSec,request=Produce
```

### 성능 튜닝 체크리스트

**하드웨어 최적화:**
- [ ] SSD 사용 권장 (NVMe > SATA SSD > HDD)
- [ ] 충분한 메모리 (OS 페이지 캐시용)
- [ ] 네트워크 대역폭 (10Gbps+ 권장)

**OS 레벨 튜닝:**
```bash
# 파일 디스크립터 한계 증가
echo "* soft nofile 100000" >> /etc/security/limits.conf
echo "* hard nofile 100000" >> /etc/security/limits.conf

# 스왑 비활성화
swapoff -a

# 디스크 스케줄러 최적화
echo deadline > /sys/block/sda/queue/scheduler
```

**애플리케이션 레벨 튜닝:**
```java
// 생산자 최적화
props.put("batch.size", 16384);
props.put("linger.ms", 10);
props.put("compression.type", "snappy");

// 소비자 최적화
props.put("fetch.min.bytes", 1024);
props.put("fetch.max.wait.ms", 500);
props.put("max.partition.fetch.bytes", 1048576);
```

## 결론

### Kafka 아키텍처의 혁신

Kafka의 성공은 **특정 도메인에 극도로 특화된 설계**에서 나옵니다:

1. **단순성**: 복잡한 데이터베이스 기능 제거, 로그 중심 구조
2. **성능**: 순차 I/O와 OS 페이지 캐시 최적화
3. **확장성**: 파티셔닝을 통한 자연스러운 수평 확장
4. **내구성**: 분산 복제를 통한 데이터 보호

### 설계 철학의 차이

**RabbitMQ (메시지 큐 패러다임)**:
- 복잡한 라우팅과 워크플로우 지원
- 강한 일관성과 정확한 메시지 전달
- 중앙집중식 제어와 관리

**Kafka (이벤트 스트리밍 패러다임)**:
- 단순하고 예측 가능한 성능
- 높은 처리량과 확장성 우선
- 분산 제어와 자동화

### 선택 가이드라인

**Kafka를 선택해야 하는 경우:**
- 초당 수십만 건 이상의 메시지 처리
- 실시간 데이터 파이프라인 구축
- 이벤트 소싱 아키텍처 구현
- 마이크로서비스 간 비동기 통신

**RabbitMQ를 선택해야 하는 경우:**
- 복잡한 라우팅 규칙 필요
- 트랜잭션과 강한 일관성 요구
- 태스크 큐와 작업 분배 시스템
- 메시지 우선순위 처리 필요

현대의 데이터 중심 애플리케이션에서 Kafka의 **단일 책임 원칙**을 시스템 레벨에서 구현한 아키텍처는 분산 시스템 설계의 새로운 패러다임을 제시했습니다. 범용성을 포기하고 특정 도메인에 특화함으로써 혁신적인 성능과 확장성을 달성한 대표적인 사례라고 할 수 있습니다.