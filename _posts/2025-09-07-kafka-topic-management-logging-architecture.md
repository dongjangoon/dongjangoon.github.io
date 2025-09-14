---
layout: single
title: "Kafka를 활용한 로그 수집 아키텍처: 토픽 설계부터 운영 최적화까지"
date: 2025-09-07 16:00:00 +0000
categories: monitoring
tags: [kafka, logging, architecture, topic-management, kubernetes]
excerpt: "Kubernetes 환경에서 Kafka를 활용한 대용량 로그 수집 시스템의 토픽 설계 전략과 운영 최적화 방안을 실무 경험을 바탕으로 공유합니다."
---

# Kafka를 활용한 로그 수집 아키텍처: 토픽 설계부터 운영 최적화까지

대용량 로그 처리 시스템에서 Kafka는 안정적인 데이터 스트리밍과 확장성을 제공하는 핵심 컴포넌트입니다. 특히 Kubernetes 환경에서 여러 클러스터의 로그를 중앙 집중식으로 수집할 때, 적절한 토픽 설계와 파티셔닝 전략이 전체 시스템의 성능을 좌우합니다. 이번 포스트에서는 실무에서 적용한 Kafka 기반 로그 수집 아키텍처의 설계 원칙과 최적화 경험을 공유하겠습니다.

## Kafka 기반 로그 수집 아키텍처 개요

### 전체 아키텍처 구성

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Cluster 1     │    │   Cluster 2     │    │   Cluster N     │
│                 │    │                 │    │                 │
│  ┌───────────┐  │    │  ┌───────────┐  │    │  ┌───────────┐  │
│  │FluentBit  │──┼────┼──│FluentBit  │──┼────┼──│FluentBit  │──┼─┐
│  └───────────┘  │    │  └───────────┘  │    │  └───────────┘  │ │
└─────────────────┘    └─────────────────┘    └─────────────────┘ │
                                                                  │
                            ┌─────────────────────────────────────┘
                            │
                            ▼
                  ┌─────────────────┐
                  │  Kafka Cluster  │
                  │                 │
                  │  ┌───────────┐  │
                  │  │kubernetes-│  │    ┌─────────────────┐
                  │  │logs       │  │    │                 │
                  │  └───────────┘  │────│   OpenSearch    │
                  │  ┌───────────┐  │    │   Cluster       │
                  │  │app-logs   │  │    │                 │
                  │  └───────────┘  │    └─────────────────┘
                  │  ┌───────────┐  │
                  │  │system-logs│  │
                  │  └───────────┘  │
                  └─────────────────┘
```

이러한 아키텍처는 **로그 소스와 저장소 간의 디커플링**을 통해 시스템의 탄력성과 확장성을 크게 향상시킵니다.

## Kafka 설치 및 기본 설정

### Java 환경 준비 및 Kafka 설치

Kafka 4.0을 기준으로 한 설치 과정:

```bash
# Java 23 설치 (Amazon Corretto 권장)
sudo dnf install -y java-23-amazon-corretto-devel

# JAVA_HOME 환경변수 설정 확인
java -version

# Kafka 4.0 다운로드
wget https://downloads.apache.org/kafka/4.0.0/kafka_2.13-4.0.0.tgz

# 압축 해제 및 디렉토리 이동
tar -xzf kafka_2.13-4.0.0.tgz
cd kafka_2.13-4.0.0

# 클러스터 ID 생성 (KIP-853에 따른 새로운 방식)
CLUSTER_ID=$(bin/kafka-storage.sh random-uuid)
echo $CLUSTER_ID

# 로그 디렉토리 포맷 (최초 실행 시 필수)
bin/kafka-storage.sh format -t $CLUSTER_ID -c config/server.properties --standalone
```

### Kafka 서버 실행

```bash
# 포그라운드 실행 (개발/테스트 환경)
bin/kafka-server-start.sh config/server.properties

# 백그라운드 실행 (프로덕션 환경 권장)
bin/kafka-server-start.sh -daemon config/server.properties

# 실행 상태 확인
ps aux | grep kafka
netstat -tlnp | grep 9092
```

## 로그 수집용 토픽 설계 전략

### 토픽 분류 기준

실무에서 고민했던 **토픽 분리 전략**은 다음과 같은 기준으로 수립했습니다:

1. **로그 타입별 분리**: 애플리케이션 로그, 시스템 로그, 에러 로그
2. **소스별 분리**: 클러스터별 또는 네임스페이스별
3. **중요도별 분리**: 실시간 알림 필요 여부에 따른 우선순위

### 통합 로그 토픽 (권장 설정)

가장 일반적으로 사용하는 통합 로그 토픽 설정:

```bash
# 통합 Kubernetes 로그 토픽 - 모든 클러스터의 로그를 하나의 토픽으로 수집
kafka-topics.sh --create \
  --bootstrap-server $PLAINTEXT:9092 \
  --topic kubernetes-logs \
  --partitions 6 \                      # 병렬 처리를 위한 파티션 수 (노드 수의 2배 권장)
  --replication-factor 1 \              # 단일 브로커 환경에서는 1
  --config cleanup.policy=delete \      # 오래된 로그 자동 삭제 정책
  --config retention.ms=604800000 \     # 7일 보존 (7 * 24 * 60 * 60 * 1000 ms)
  --config compression.type=snappy      # 압축으로 디스크 사용량 절약 (20-30% 절약)
```

**파티션 수 선택 기준**:
- **3-6개**: 소규모 환경 (일일 로그 100GB 미만)
- **6-12개**: 중규모 환경 (일일 로그 100GB-1TB)
- **12개 이상**: 대규모 환경 (일일 로그 1TB 이상)

### 용도별 토픽 분리 (확장 시 고려)

로그 볼륨이 증가하거나 특별한 처리가 필요한 경우:

```bash
# 애플리케이션 로그 토픽 - 비즈니스 로직 관련 로그
kafka-topics.sh --create \
  --bootstrap-server $PLAINTEXT:9092 \
  --topic app-logs \
  --partitions 3 \
  --replication-factor 1 \
  --config retention.ms=1209600000      # 14일 보존 (중요 비즈니스 로그)

# 시스템 로그 토픽 - OS 및 인프라 관련 로그  
kafka-topics.sh --create \
  --bootstrap-server $PLAINTEXT:9092 \
  --topic system-logs \
  --partitions 3 \
  --replication-factor 1 \
  --config retention.ms=604800000       # 7일 보존

# 에러 로그 토픽 - 즉시 알림이 필요한 에러 로그
kafka-topics.sh --create \
  --bootstrap-server $PLAINTEXT:9092 \
  --topic error-logs \
  --partitions 2 \                      # 에러 로그는 상대적으로 적은 볼륨
  --replication-factor 1 \
  --config retention.ms=2592000000      # 30일 보존 (장기 분석용)
```

## 토픽 관리 및 최적화

### 기본 토픽 관리 명령어

```bash
# 토픽 목록 조회 - 생성된 모든 토픽 확인
kafka-topics.sh --list --bootstrap-server $PLAINTEXT:9092

# 토픽 상세 정보 조회 - 파티션, 복제본, 설정 정보 확인
kafka-topics.sh --describe \
  --bootstrap-server $PLAINTEXT:9092 \
  --topic kubernetes-logs

# 출력 예시:
# Topic: kubernetes-logs  PartitionCount: 6  ReplicationFactor: 1
# Topic: kubernetes-logs  Partition: 0  Leader: 0  Replicas: 0  Isr: 0
# Topic: kubernetes-logs  Partition: 1  Leader: 0  Replicas: 0  Isr: 0
# ...
```

### 토픽 설정 최적화

운영 중에 토픽 설정을 조정하는 경우:

```bash
# 보존 기간 변경 - 스토리지 용량에 따라 동적 조정
kafka-configs.sh --alter \
  --bootstrap-server $PLAINTEXT:9092 \
  --entity-type topics \
  --entity-name kubernetes-logs \
  --add-config retention.ms=1209600000  # 7일 → 14일로 변경

# 파티션 수 증가 - 처리량 증가가 필요한 경우 (주의: 감소는 불가능)
kafka-topics.sh --bootstrap-server $PLAINTEXT:9092 \
  --topic kubernetes-logs \
  --alter \
  --partitions 12                       # 6개 → 12개로 증가

# 압축 설정 추가 - 디스크 사용량 최적화
kafka-configs.sh --bootstrap-server $PLAINTEXT:9092 \
  --entity-type topics \
  --entity-name kubernetes-logs \
  --alter \
  --add-config compression.type=lz4     # snappy → lz4로 변경 (더 빠른 압축)
```

**압축 타입별 특성**:
- **snappy**: 균형잡힌 압축률과 속도 (권장)
- **lz4**: 빠른 압축/해제 속도, 낮은 압축률
- **gzip**: 높은 압축률, 느린 속도 (스토리지 비용 민감한 경우)

### 토픽 삭제 (주의 필요)

```bash
# 토픽 삭제 - 데이터 손실 위험이 있으므로 신중하게 실행
kafka-topics.sh --delete \
  --bootstrap-server $PLAINTEXT:9092 \
  --topic old-logs

# 삭제 확인
kafka-topics.sh --list --bootstrap-server $PLAINTEXT:9092 | grep old-logs
```

## Consumer 모니터링 및 관리

### Consumer Group 상태 모니터링

로그 수집 시스템의 안정성을 위해서는 Consumer의 상태를 지속적으로 모니터링해야 합니다:

```bash
# 모든 Consumer Group 목록 조회
kafka-consumer-groups.sh --bootstrap-server $PLAINTEXT:9092 --list

# 특정 Consumer Group 상세 정보 - 지연(lag) 및 처리 현황 확인
kafka-consumer-groups.sh --bootstrap-server $PLAINTEXT:9092 \
  --group fluentbit-consumers \
  --describe

# 출력 예시에서 중요한 지표:
# GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# fluentbit-consumers kubernetes-logs 0      12500          12500          0    # LAG=0: 정상
# fluentbit-consumers kubernetes-logs 1      8900           9100           200  # LAG=200: 지연 발생

# 모든 Consumer Group 상세 정보 - 전체 시스템 상태 파악
kafka-consumer-groups.sh --bootstrap-server $PLAINTEXT:9092 \
  --all-groups \
  --describe
```

**LAG 모니터링 기준**:
- **LAG < 1000**: 정상 상태
- **LAG 1000-10000**: 주의 필요 (Consumer 성능 점검)
- **LAG > 10000**: 경고 상태 (Consumer 추가 또는 성능 개선 필요)

## 실무에서의 운영 최적화 경험

### 파티셔닝 전략의 중요성

**초기 설정의 실수와 교훈**:
처음에는 파티션을 3개로 설정했다가, 로그 볼륨이 증가하면서 처리 지연이 발생했습니다.
따라서 아래와 같은 점들을 고려했습니다.

1. **파티션 수는 예상 로드의 2배로 설정**: 확장성 여유 공간 확보
2. **Consumer 인스턴스 수 ≤ 파티션 수**: 파티션보다 많은 Consumer는 유휴 상태
3. **파티션 증가는 가능하지만 감소는 불가**: 초기 설계의 중요성

### 압축과 보존 정책의 균형

**스토리지 비용과 성능의 트레이드오프**:
```yaml
# 스토리지 관련 설정
retention.ms: 604800000        # 7일 (로그 분석 주기 고려)
compression.type: snappy       # 20-30% 압축률, 적당한 CPU 오버헤드
segment.ms: 86400000          # 1일 단위 세그먼트 (관리 용이성)
```

이 설정으로 **일일 80GB 로그를 약 56GB(30% 절약)**로 압축하여 저장할 수 있었습니다.

### 장애 대응 시나리오

**Consumer Lag 급증 시 대응**:
```bash
# 1. 현재 지연 상태 파악
kafka-consumer-groups.sh --bootstrap-server $PLAINTEXT:9092 \
  --group fluentbit-consumers --describe

# 2. Producer 처리량 확인  
kafka-run-class.sh kafka.tools.JmxTool \
  --object-name kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec,topic=kubernetes-logs

# 3. Consumer 인스턴스 증설 또는 파티션 증가 검토
# 4. 임시적으로 불필요한 로그 필터링 적용
```

**브로커 장애 시 복구**:
```bash
# 브로커 상태 확인
kafka-broker-api-versions.sh --bootstrap-server $PLAINTEXT:9092

# 복제본 재할당 (필요시)
kafka-reassign-partitions.sh --bootstrap-server $PLAINTEXT:9092 \
  --reassignment-json-file reassignment.json \
  --execute
```

## 모니터링 및 알림 설정

### 핵심 모니터링 지표

```yaml
# Kafka 클러스터 레벨
cluster_metrics:
  - kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec
  - kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec  
  - kafka.server:type=ReplicaManager,name=LeaderCount

# 토픽 레벨
topic_metrics:
  - kafka.server:type=BrokerTopicMetrics,name=TotalProduceRequestsPerSec,topic=kubernetes-logs
  - kafka.server:type=BrokerTopicMetrics,name=FailedProduceRequestsPerSec,topic=kubernetes-logs

# Consumer Group 레벨  
consumer_metrics:
  - kafka.consumer:type=consumer-fetch-manager-metrics,client-id=fluentbit
  - kafka.consumer:type=consumer-coordinator-metrics,client-id=fluentbit
```

### Prometheus 기반 알림 규칙

```yaml
groups:
- name: kafka.rules
  rules:
  - alert: KafkaConsumerLagHigh
    expr: kafka_consumer_lag_sum{group="fluentbit-consumers"} > 10000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Kafka consumer lag is high"
      description: "Consumer group fluentbit-consumers has lag {% raw %}{{ $value }}{% endraw %}"

  - alert: KafkaTopicPartitionOffline
    expr: kafka_topic_partition_leader == -1
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Kafka topic partition is offline"
```

## 결론

Kafka 운영에서 중요한 것은 **적절한 토픽 설계와 지속적인 모니터링(스토리지, Lag 여부)**입니다.

위 글은 Kafka를 활용한 로깅 아키텍처 글이었습니다만, 아마 Kafka를 사용할 때 중요한 점은 다른 케이스에서도 비슷할 거라 생각됩니다. 특히 설계와 운영시에 아래와 같은 점들을 고려해야 합니다.

### 설계 단계에서의 고려사항
1. **파티션 수 결정**: 현재 로드에 비해 여유를 두고 설정하여 확장성 확보
2. **보존 정책**: 비즈니스 요구사항과 스토리지 비용의 균형점 찾기
3. **압축 설정**: snappy 압축으로 성능과 저장 공간의 최적 균형

### 운영 단계에서의 핵심
1. **Consumer Lag 모니터링**: 알림을 통해 예상치 못한 장애에 대비하기
2. **점진적 최적화**: 실제 사용 패턴을 바탕으로 한 설정 조정

항상 기술을 도입할 때 드는 생각이지만 **"완벽한 초기 설계도 중요하지만, 운영 역시 중요하다"**는 것입니다. 로그 패턴과 볼륨은 서비스 성장과 함께 변화하므로, 모니터링 데이터를 바탕으로 한 지속적인 최적화가 필수입니다.

---

**관련 포스트**
- [FluentBit과 OpenSearch를 활용한 로그 수집 및 최적화](/kubernetes/monitoring/2025/09/07/fluentbit-opensearch-log-collection-optimization/)
- [Kubernetes Logging Architecture](/kubernetes/2025/04/09/kubernetes-logging-architecture/)