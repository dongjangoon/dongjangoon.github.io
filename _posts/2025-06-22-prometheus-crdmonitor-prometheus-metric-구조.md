---
layout: single
title: "Prometheus CRD(Monitor, Prometheus), Metric 구조"
date: 2025-06-22 06:03:00 +0000
categories: monitoring
tags: [tech, monitoring, observability]
excerpt: "ServiceMonitor는 Kubernetes Service를 통해 메트릭을 수집합니다. Prometheus Operator가 ServiceMonitor 리소스를 감시하다가 새로운 ServiceMonitor가 생성되면, 해당 ServiceMonitor의 selector와 매칭되는 Service를 찾습니다."
notion_id: 21aeef64-a1ca-8083-b3e9-fcd646b7da50
notion_url: https://www.notion.so/Prometheus-CRD-Monitor-Prometheus-Metric-21aeef64a1ca8083b3e9fcd646b7da50
---

## 동작 원리

**ServiceMonitor**는 Kubernetes Service를 통해 메트릭을 수집합니다. Prometheus Operator가 ServiceMonitor 리소스를 감시하다가 새로운 ServiceMonitor가 생성되면, 해당 ServiceMonitor의 selector와 매칭되는 Service를 찾고, 그 Service의 엔드포인트들을 Prometheus 설정에 자동으로 추가합니다. Service의 포트 중에서 메트릭 수집용으로 지정된 포트로 스크래핑을 수행합니다.

<!--more-->
**PodMonitor**는 Service를 거치지 않고 Pod를 직접 타겟으로 합니다. PodMonitor의 selector 조건에 맞는 Pod들을 직접 찾아서 메트릭을 수집합니다. 이는 Service가 없거나 Service를 통하지 않고 직접 Pod에서 메트릭을 가져와야 하는 경우에 유용합니다.

## 구현 시 핵심 고려사항

**라벨 셀렉터 설계**가 가장 중요합니다. ServiceMonitor나 PodMonitor의 selector는 정확하고 명확해야 합니다. 너무 광범위하면 불필요한 메트릭을 수집하게 되고, 너무 제한적이면 필요한 메트릭을 놓칠 수 있습니다. 애플리케이션에 일관된 라벨링 전략을 적용하는 것이 중요합니다.

**네임스페이스 관리**도 신경써야 합니다. namespaceSelector를 통해 특정 네임스페이스만 모니터링하거나, 여러 네임스페이스를 포함할 수 있습니다. 보안과 리소스 관리 측면에서 적절한 범위를 설정해야 합니다.

**메트릭 엔드포인트 설정**에서는 포트 이름과 경로를 정확히 지정해야 합니다. 일반적으로 `/metrics` 경로를 사용하지만, 애플리케이션에 따라 다를 수 있습니다. HTTPS를 사용하는 경우 TLS 설정도 필요합니다.

**스크래핑 간격과 타임아웃** 설정은 시스템 부하와 메트릭의 중요도를 고려해 결정해야 합니다. 너무 짧으면 시스템에 부하를 주고, 너무 길면 중요한 이벤트를 놓칠 수 있습니다.

**메트릭 릴레이블링**을 통해 불필요한 메트릭을 필터링하거나 라벨을 수정할 수 있습니다. 이는 스토리지 비용과 쿼리 성능에 직접적인 영향을 줍니다.

**RBAC 권한** 설정도 빼놓을 수 없습니다. Prometheus가 Service와 Pod, Endpoint 리소스에 접근할 수 있는 적절한 권한이 있어야 합니다.

**고가용성 환경**에서는 여러 Prometheus 인스턴스가 같은 타겟을 중복으로 스크래핑하지 않도록 샤딩 설정을 고려해야 합니다.

마지막으로 **애플리케이션 준비성**을 확인해야 합니다. 애플리케이션이 실제로 메트릭 엔드포인트를 제공하고 있는지, 메트릭 형식이 Prometheus와 호환되는지 사전에 검증하는 것이 중요합니다.

## Prometheus와 ServiceMonitor 연결 메커니즘

Prometheus 리소스에는 `serviceMonitorSelector` 필드가 있습니다. 이 selector와 매칭되는 라벨을 가진 ServiceMonitor만 해당 Prometheus 인스턴스가 인식하고 스크래핑 설정에 포함시킵니다.

```yaml
# Prometheus 리소스 예시 (Pod가 아니라 CRD)
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

```yaml
# ServiceMonitor 예시
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app-monitor
  labels:
    release: prometheus # Prometheus selector와 매칭
spec:
  selector:
    matchLabels:
      app: my-application
```

## 주의할 점들

**라벨 불일치**가 가장 흔한 문제입니다. ServiceMonitor에 라벨이 없거나 Prometheus의 serviceMonitorSelector와 맞지 않으면 메트릭 수집이 전혀 되지 않습니다.

**여러 Prometheus 인스턴스** 환경에서는 각각 다른 serviceMonitorSelector를 사용해서 ServiceMonitor를 분리할 수 있습니다. 예를 들어 개발환경용, 운영환경용 Prometheus를 구분할 때 유용합니다.

**빈 selector** 설정도 가능합니다. `serviceMonitorSelector: {}`로 설정하면 모든 ServiceMonitor를 수집하지만, 보안과 관리 측면에서 권장하지 않습니다.

**네임스페이스 제한**도 함께 고려해야 합니다. `serviceMonitorNamespaceSelector`를 통해 특정 네임스페이스의 ServiceMonitor만 선택할 수도 있습니다.

결국 ServiceMonitor 생성 시에는 항상 "이 ServiceMonitor를 어떤 Prometheus가 수집할 것인가?"를 먼저 확인하고, 해당 Prometheus의 serviceMonitorSelector와 매칭되는 라벨을 반드시 포함시켜야 합니다.

# Prometheus CRD

**Prometheus**:

- **역할**: Kubernetes 클러스터에 배포할 Prometheus 서버 인스턴스를 선언적으로 정의합니다.
- **기능**: Prometheus의 버전, 영구 저장소, 복제본 수, Alertmanager로 알림을 보낼 설정 등을 지정할 수 있습니다.
- **동작**: Prometheus Operator는 이 `Prometheus` 리소스의 설정을 기반으로 적절하게 구성된 StatefulSet을 배포하여 Prometheus 인스턴스를 실행합니다.
# Prometheus Metric

### Prometheus 메트릭의 구조

Prometheus 메트릭은 기본적으로 다음과 같은 구조를 가집니다:

`metric_name{label_name="label_value", ...} value`

각 구성 요소는 다음과 같은 의미를 가집니다:

io micrometer 

1. **메트릭 이름 (Metric Name)**:
1. **레이블 (Labels)**:
1. **값 (Value)**:
**예시:**

- `http_requests_total{method="post", path="/api/users", status="200"} 1024`
- `node_cpu_usage_seconds_total{cpu="0", mode="idle"} 12345.67`

### Prometheus 메트릭의 타입

Prometheus는 수집하는 데이터의 특성에 따라 네 가지 핵심 메트릭 타입을 정의합니다. 각 타입은 서로 다른 용도와 의미를 가집니다.

1. **카운터 (Counter)**:
    - **특징**: 단조롭게 증가하는(monotonically increasing) 단일 숫자 값입니다. 재시작 시 0으로 재설정될 수 있습니다.
    - **용도**: 서비스에서 발생한 총 요청 수, 완료된 작업 수, 오류 발생 횟수 등과 같이 **누적되는 값**을 측정할 때 사용됩니다.
    - **예시**: `http_requests_total` (총 HTTP 요청 수), `node_network_receive_bytes_total` (총 수신 바이트 수).
    - **활용**: `rate()` 함수나 `irate()` 함수를 사용하여 초당 증가율을 계산하는 데 주로 사용됩니다.
2. **게이지 (Gauge)**:
    - **특징**: 임의로 오르내릴 수 있는 단일 숫자 값입니다.
    - **용도**: 현재 온도, 현재 메모리 사용량, 현재 동시 접속자 수, 큐에 대기 중인 항목 수 등과 같이 **현재 상태 또는 측정치**를 나타낼 때 사용됩니다.
    - **예시**: `node_memory_active_bytes` (활성 메모리 사용량), `temperature_celsius` (현재 온도), `go_goroutines` (현재 고루틴 수).
    - **활용**: 직접적인 현재 값을 보거나, `delta()` 함수를 사용하여 값의 변화량을 확인할 수 있습니다.
3. **히스토그램 (Histogram)**:
    - **특징**: 관측된 값의 표본을 버킷(bucket)으로 분류하고, 각 버킷의 개수를 추적합니다. 또한 모든 관측치의 총합(sum)과 총 개수(count)도 제공합니다.
    - **용도**: 요청 처리 시간, 응답 크기 등과 같이 **분포를 알고 싶은 값**을 측정할 때 사용됩니다. 주로 지연 시간(latency)을 측정하는 데 유용합니다.
    - **제공되는 메트릭**:
        - `_bucket{le="..."}`: 각 버킷의 누적 개수 (less than or equal to).
        - `_sum`: 관측된 모든 값의 합계.
        - `_count`: 관측된 총 값의 개수.
    - **예시**: `http_request_duration_seconds_bucket`, `http_request_duration_seconds_sum`, `http_request_duration_seconds_count`.
    - **활용**: `histogram_quantile()` 함수를 사용하여 분위수(percentiles, 예: P90, P99)를 계산하여 분포를 이해하는 데 사용됩니다.
4. **요약 (Summary)**:
    - **특징**: 클라이언트 측에서 구성 가능한 분위수(quantiles)를 계산합니다. 또한 모든 관측치의 총합(sum)과 총 개수(count)를 제공합니다. 히스토그램과 달리 서버 측에서 분위수를 계산하지 않고, 클라이언트 측에서 미리 계산하여 전송합니다.
    - **용도**: 히스토그램과 유사하게 분포를 측정하지만, 클라이언트 측에서 미리 계산된 분위수를 제공합니다. 네트워크 비용이 높거나 데이터의 양이 매우 큰 경우에 유리할 수 있습니다.
    - **제공되는 메트릭**:
        - `{quantile="..."}`: 미리 계산된 분위수 (예: P0.5, P0.9, P0.99).
        - `_sum`: 관측된 모든 값의 합계.
        - `_count`: 관측된 총 값의 개수.
    - **예시**: `http_request_duration_seconds{quantile="0.99"}`, `http_request_duration_seconds_sum`, `http_request_duration_seconds_count`.
    - **단점**: 클라이언트 측에서 계산된 분위수는 Prometheus 서버의 집계 기능을 활용하기 어렵고, 레이블 변경에 취약할 수 있습니다. 일반적으로 **히스토그램 사용이 더 권장**됩니다.

## Exporter API 요청 및 응답 구조

- /metrics 엔드포인트로 API 요청을 보내면 응답은 기본적으로 **Prometheus exposition format**이라는 특정 텍스트 기반 형식으로 나옵니다.
- 이 텍스트 형식은 사람이 읽기 쉽고, 각 메트릭의 이름, 타입, 설명, 레이블 및 현재 값을 라인 단위로 표시합니다.
- Content-Type 헤더:
  Prometheus의 /metrics 엔드포인트의 표준 Content-Type은 일반적으로 다음과 같습니다:
    - text/plain; version=0.0.4: 이것이 가장 흔하고 널리 사용되는 기본 형식입니다.
    - application/openmetrics-text; version=1.0.0: OpenMetrics는 Prometheus exposition format의 표준화를 목표로 하는 프로젝트이며, 더 현대적이고 엄격한 사양을 제공합니다. 일부 최신 클라이언트 라이브러리나 익스포터는 Accept 헤더에 따라 이 형식을 기본으로 제공하거나 지원할 수 있습니다.
    - Prometheus 서버가 /metrics 엔드포인트에 요청을 보낼 때, 일반적으로 Accept 헤더를 통해 자신이 지원하는 메트릭 포맷들을 명시합니다. 그러면 메트릭을 노출하는 애플리케이션(Exporter)은 이 Accept 헤더를 보고 가장 적절한 포맷으로 응답을 돌려줍니다. 만약 Accept 헤더가 없거나 적절한 포맷을 찾지 못하면, 대부분의 구현체는 기본적으로 text/plain; version=0.0.4 형식으로 응답합니다.
- 일부 모니터링 시스템이나 특정 익스포터는 Prometheus 형식 외에 JSON, CSV 등 다른 형식으로도 메트릭을 노출하는 옵션을 제공할 수 있지만, 이는 Prometheus 생태계의 표준 방식은 아닙니다. Prometheus와 연동하려면 Prometheus exposition format을 따라야 합니다.

---

*Originally published in [Notion](https://www.notion.so/Prometheus-CRD-Monitor-Prometheus-Metric-21aeef64a1ca8083b3e9fcd646b7da50) on June 22, 2025*