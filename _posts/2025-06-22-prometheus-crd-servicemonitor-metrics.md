---
layout: single
title: "Prometheus CRD(ServiceMonitor, PodMonitor)와 Metric 구조"
date: 2025-06-22 06:03:00 +0000
categories: [monitoring]
tags: [prometheus, kubernetes, servicemonitor, podmonitor, metrics]
excerpt: "Prometheus Operator의 핵심 CRD인 ServiceMonitor와 PodMonitor의 동작 원리, 그리고 Prometheus 메트릭의 구조와 타입을 알아봅니다."
---

## ServiceMonitor와 PodMonitor 동작 원리

### ServiceMonitor

**ServiceMonitor** 는 Kubernetes Service를 통해 메트릭을 수집합니다.

<!--more-->

```
┌─────────────────────────────────────────────────────────────────┐
│                    ServiceMonitor 동작 흐름                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Prometheus Operator가 ServiceMonitor 리소스 감시            │
│  2. 새 ServiceMonitor 생성 시 selector와 매칭되는 Service 검색   │
│  3. Service의 엔드포인트를 Prometheus 설정에 자동 추가           │
│  4. 지정된 포트로 /metrics 스크래핑 수행                         │
└─────────────────────────────────────────────────────────────────┘
```

### PodMonitor

**PodMonitor** 는 Service를 거치지 않고 Pod를 직접 타겟으로 합니다.

- PodMonitor의 selector 조건에 맞는 Pod를 직접 검색
- Service가 없거나 직접 Pod에서 메트릭을 가져와야 하는 경우 유용

---

## 구현 시 핵심 고려사항

### 1. 라벨 셀렉터 설계

ServiceMonitor나 PodMonitor의 selector는 정확하고 명확해야 합니다.

| 문제 | 결과 |
|------|------|
| 너무 광범위한 selector | 불필요한 메트릭 수집, 리소스 낭비 |
| 너무 제한적인 selector | 필요한 메트릭 누락 |

**권장**: 애플리케이션에 일관된 라벨링 전략 적용

### 2. 네임스페이스 관리

`namespaceSelector`를 통해 모니터링 범위를 제한할 수 있습니다.

```yaml
spec:
  namespaceSelector:
    matchNames:
      - production
      - staging
```

### 3. 메트릭 엔드포인트 설정

```yaml
spec:
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

### 4. 메트릭 릴레이블링

불필요한 메트릭을 필터링하거나 라벨을 수정할 수 있습니다.

```yaml
spec:
  endpoints:
    - port: metrics
      metricRelabelings:
        - sourceLabels: [__name__]
          regex: 'go_.*'
          action: drop
```

### 5. RBAC 권한

Prometheus가 Service, Pod, Endpoint 리소스에 접근할 수 있는 권한이 필요합니다.

---

## Prometheus와 ServiceMonitor 연결

Prometheus 리소스의 `serviceMonitorSelector`와 ServiceMonitor의 라벨이 매칭되어야 합니다.

### Prometheus CRD

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  serviceMonitorNamespaceSelector: {}
  serviceMonitorSelector:
    matchLabels:
      release: prometheus
  podMonitorSelector:
    matchLabels:
      release: prometheus
```

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app-monitor
  labels:
    release: prometheus  # Prometheus selector와 매칭
spec:
  selector:
    matchLabels:
      app: my-application
  endpoints:
    - port: metrics
      path: /metrics
```

### 주의사항

| 상황 | 결과 |
|------|------|
| 라벨 불일치 | 메트릭 수집 안됨 |
| `serviceMonitorSelector: {}` | 모든 ServiceMonitor 수집 (비권장) |
| 여러 Prometheus 인스턴스 | 다른 selector로 분리 가능 |

---

## Prometheus CRD: Prometheus

Kubernetes 클러스터에 배포할 Prometheus 서버 인스턴스를 선언적으로 정의합니다.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  replicas: 2
  version: v2.47.0
  retention: 15d
  storage:
    volumeClaimTemplate:
      spec:
        resources:
          requests:
            storage: 50Gi
  alerting:
    alertmanagers:
      - name: alertmanager
        namespace: monitoring
        port: web
```

Prometheus Operator는 이 리소스를 기반으로 StatefulSet을 배포합니다.

---

## Prometheus Metric 구조

### 기본 형식

```
metric_name{label_name="label_value", ...} value
```

| 구성 요소 | 설명 | 예시 |
|----------|------|------|
| metric_name | 메트릭 이름 | `http_requests_total` |
| labels | 메트릭 차원을 나타내는 키-값 쌍 | `{method="POST", status="200"}` |
| value | 측정값 (숫자) | `1024` |

**예시**
```
http_requests_total{method="post", path="/api/users", status="200"} 1024
node_cpu_usage_seconds_total{cpu="0", mode="idle"} 12345.67
```

---

## Prometheus Metric 타입

### 1. Counter (카운터)

단조롭게 증가하는 누적 값입니다.

**특징**
- 재시작 시에만 0으로 리셋
- 감소하지 않음

**용도**: 총 요청 수, 오류 횟수, 완료된 작업 수

**예시**
```
http_requests_total{method="GET"} 1234
node_network_receive_bytes_total 987654321
```

**활용**: `rate()`, `irate()` 함수로 초당 증가율 계산

```promql
rate(http_requests_total[5m])
```

### 2. Gauge (게이지)

임의로 오르내릴 수 있는 현재 상태 값입니다.

**용도**: 현재 메모리 사용량, 온도, 동시 접속자 수

**예시**
```
node_memory_active_bytes 1073741824
temperature_celsius 45.2
go_goroutines 42
```

**활용**: 현재 값 조회 또는 `delta()` 함수로 변화량 확인

### 3. Histogram (히스토그램)

관측값의 분포를 버킷으로 분류합니다.

**제공되는 메트릭**

| 메트릭 | 설명 |
|--------|------|
| `_bucket{le="..."}` | 각 버킷의 누적 개수 |
| `_sum` | 모든 관측값의 합계 |
| `_count` | 총 관측 횟수 |

**예시**
```
http_request_duration_seconds_bucket{le="0.1"} 24054
http_request_duration_seconds_bucket{le="0.5"} 33444
http_request_duration_seconds_bucket{le="1"} 34567
http_request_duration_seconds_bucket{le="+Inf"} 34789
http_request_duration_seconds_sum 8753.4
http_request_duration_seconds_count 34789
```

**활용**: `histogram_quantile()` 함수로 백분위수(P90, P99) 계산

```promql
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
```

### 4. Summary (요약)

클라이언트 측에서 계산된 분위수를 제공합니다.

**제공되는 메트릭**

| 메트릭 | 설명 |
|--------|------|
| `{quantile="..."}` | 미리 계산된 분위수 |
| `_sum` | 모든 관측값의 합계 |
| `_count` | 총 관측 횟수 |

**예시**
```
http_request_duration_seconds{quantile="0.5"} 0.05
http_request_duration_seconds{quantile="0.9"} 0.1
http_request_duration_seconds{quantile="0.99"} 0.2
http_request_duration_seconds_sum 8753.4
http_request_duration_seconds_count 34789
```

**주의**: 클라이언트 측 계산으로 인해 서버에서 집계가 어려움. **일반적으로 Histogram 사용 권장**

---

## Exporter API 요청 및 응답

### 요청

```bash
curl http://localhost:9090/metrics
```

### 응답 형식

**Prometheus exposition format** (text/plain; version=0.0.4)

```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 1234
http_requests_total{method="POST",status="201"} 567

# HELP node_memory_active_bytes Currently active memory
# TYPE node_memory_active_bytes gauge
node_memory_active_bytes 1073741824
```

### Content-Type

| 형식 | Content-Type |
|------|-------------|
| 기본 형식 | `text/plain; version=0.0.4` |
| OpenMetrics | `application/openmetrics-text; version=1.0.0` |

Prometheus는 `Accept` 헤더로 지원 형식을 명시하고, Exporter가 적절한 형식으로 응답합니다.
