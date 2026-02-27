---
layout: single
title: "Tempo Tracing 트러블슈팅: HikariCP 커넥션과 긴 트레이스 문제"
date: 2025-06-18 12:53:00 +0000
last_modified_at: 2026-02-17
categories: [monitoring]
tags: [tempo, tracing, hikaricp, opentelemetry, spring]
excerpt: "HikariCP 커넥션 유지 쿼리가 Tempo 트레이스에서 비정상적으로 긴 시간(19시간, 1시간)으로 표시되는 문제의 원인과 해결 방법을 알아봅니다."
---

## 문제 현상

Tempo UI에서 특정 요청의 트레이스가 비정상적으로 긴 시간(19시간, 1시간 등)으로 표시되는 문제가 발생했습니다.

<!--more-->

### 상세 증상

- HikariCP에서 커넥션 유지 쿼리가 요청 처리 완료 후에도 30분 주기로 발생
- 트레이스에서 `db.statement: "SET application_name = ?"`로 표시
- `thread.name: HikariPool-1 connection adder`
- `thread.id`는 매번 다른 값으로 변경됨

### 문제가 된 설정

```yaml
spring:
  datasource:
    hikari:
      data-source-properties:
        applicationName: ATGH-BATCH
      pool-name: app
      maximum-pool-size: 100
      minimum-idle: 50
      max-lifetime: 1800000      # 30분
      connection-timeout: 30000
      connection-init-sql: SET application_name = 'ATGH-BATCH'
      connection-test-query: select 1
```

---

## 원인 분석

### HikariCP 내부 동작

1. **minimum-idle 유지**: 커넥션 풀에 최소 50개의 유휴 커넥션을 유지
2. **백그라운드 스레드**: 유휴 커넥션이 50개 미만이 되면 `HikariPool-1 connection adder` 스레드가 새 커넥션 추가
3. **max-lifetime 주기**: 30분(1800000ms)마다 커넥션이 갱신되면서 `connection-init-sql` 쿼리 실행
4. **새 스레드 생성**: 매번 새로운 스레드를 사용하므로 `thread.id`가 계속 변경

### OpenTelemetry Agent의 동작

**핵심 원인**: OpenTelemetry Agent가 백그라운드 작업을 계측할 때, 적절한 부모 span을 찾지 못하면 **트레이스의 루트 span에 연결**하는 전략을 사용합니다.

```
┌─────────────────────────────────────────────────────────────────┐
│ 정상적인 트레이스                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Root Span: HTTP Request (100ms)                             │ │
│ │   └─ Child Span: DB Query (20ms)                            │ │
│ │   └─ Child Span: Business Logic (80ms)                      │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 문제가 있는 트레이스                                              │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Root Span: HTTP Request (19 hours?!)                        │ │
│ │   └─ Child Span: DB Query (20ms)                            │ │
│ │   └─ Child Span: Business Logic (80ms)                      │ │
│ │   └─ ??? HikariCP connection-init-sql (orphan span)         │ │
│ │       └─ 30분 후 실행되는 백그라운드 쿼리가                     │ │
│ │           루트 span에 연결됨                                   │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 해결 방법

### 방법 1: OpenTelemetry Agent 설정으로 HikariCP 계측 제외

`OTEL_INSTRUMENTATION_HIKARICP_ENABLED=false` 환경 변수를 설정하여 HikariCP 계측을 비활성화합니다.

```yaml
# Kubernetes Deployment
env:
  - name: OTEL_INSTRUMENTATION_HIKARICP_ENABLED
    value: "false"
```

또는 Java 에이전트 옵션으로 설정합니다.

```bash
-Dotel.instrumentation.hikaricp.enabled=false
```

### 방법 2: 특정 스레드명 패턴 제외

OpenTelemetry 설정에서 특정 스레드 패턴을 계측에서 제외합니다.

```properties
otel.instrumentation.common.excluded-threads=HikariPool.*
```

### 방법 3: Sampler 설정으로 필터링

커스텀 Sampler를 구현하여 특정 span을 샘플링에서 제외합니다.

```java
public class CustomSampler implements Sampler {
    @Override
    public SamplingResult shouldSample(
            Context parentContext,
            String traceId,
            String name,
            SpanKind spanKind,
            Attributes attributes,
            List<LinkData> parentLinks) {

        // HikariCP 관련 span 제외
        if (name.contains("connection adder") ||
            name.contains("SET application_name")) {
            return SamplingResult.drop();
        }
        return SamplingResult.recordAndSample();
    }
}
```

### 방법 4: connection-init-sql 제거

꼭 필요하지 않다면 `connection-init-sql` 설정을 제거합니다.

```yaml
spring:
  datasource:
    hikari:
      # connection-init-sql 제거
      # connection-init-sql: SET application_name = 'ATGH-BATCH'
```

---

## 권장 해결책

**방법 1 (HikariCP 계측 비활성화)** 이 가장 간단하고 효과적입니다.

실제 DB 쿼리 성능은 JDBC 계측으로 충분히 모니터링되므로, HikariCP 커넥션 풀 내부 동작까지 트레이싱할 필요가 없는 경우가 대부분입니다.

```yaml
env:
  - name: OTEL_INSTRUMENTATION_HIKARICP_ENABLED
    value: "false"
  - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
    value: "true"  # DB 쿼리는 계속 추적
```

---

## 참고: HikariCP 커넥션 풀 모니터링

HikariCP 내부 동작은 트레이싱 대신 메트릭으로 모니터링하는 것이 더 적절합니다.

```yaml
# Micrometer + Prometheus 메트릭
hikaricp_connections_active
hikaricp_connections_idle
hikaricp_connections_pending
hikaricp_connections_timeout_total
hikaricp_connections_creation_seconds
```

이 메트릭들은 커넥션 풀 상태를 효과적으로 모니터링하면서, 트레이스 데이터를 오염시키지 않습니다.
