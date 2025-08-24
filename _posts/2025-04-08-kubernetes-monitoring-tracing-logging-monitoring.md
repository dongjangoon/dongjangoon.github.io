---
layout: post
title: "Complete Guide to Kubernetes Monitoring: Tracing, Logging, and Metrics"
date: 2025-04-08 09:47:00 +0000
categories: kubernetes monitoring observability
tags: [kubernetes, monitoring, prometheus, grafana, loki, tempo, opentelemetry, observability]
excerpt: "A comprehensive guide to monitoring Kubernetes clusters with the three pillars of observability: metrics, logs, and traces using Prometheus, Grafana, Loki, and OpenTelemetry."
notion_id: 1cfeef64-a1ca-80ef-955c-e037e530e2c5
notion_url: https://www.notion.so/Kubernetes-Monitoring-Tracing-Logging-Monitoring-1cfeef64a1ca80ef955ce037e530e2c5
---

Monitoring Kubernetes environments requires a fundamental shift from traditional server monitoring approaches. With dynamic workloads, ephemeral containers, and distributed architectures, we need comprehensive observability that goes beyond simple CPU and memory metrics.

This guide explores the complete monitoring ecosystem for Kubernetes, covering the three pillars of observability: **metrics**, **logs**, and **traces**.

<!--more-->

## Table of Contents

1. [Kubernetes Monitoring Paradigm Shift](#kubernetes-monitoring-paradigm-shift)
2. [Monitoring Architectures: Pull vs Push](#monitoring-architectures-pull-vs-push)
3. [Kubernetes Monitoring Pipelines](#kubernetes-monitoring-pipelines)
4. [What to Monitor in Kubernetes](#what-to-monitor)
5. [Implementation: The Complete Stack](#implementation-the-complete-stack)

---

# Kubernetes Monitoring Paradigm Shift

## 1. 쿠버네티스 환경의 모니터링 관점 변화

### 1.1 기존 환경 vs 쿠버네티스 환경

사용자가 정의한 상태대로 얼마나 노드에 수 개의 컨테이너가 배포되어 애플리케이션이 실행 중이라는 것을 보장하는 것이 쿠버네티스이므로, 또한 OS 위에 컨테이너가 생성되어 라이프사이클이 생겨납니다. 이로 인해 모니터링의 관점 변화가 필요합니다.

쿠버네티스가 아닌 환경의 모니터링은 다음 그림과 같습니다. 

보통 각** 서버는 특정 역할(WEB, DB 등)을 가지고 있고, 모니터링 에이전트를 설치해 정보를 수집하고, 이를 모니터링 백엔드로 전달**합니다. 이를 **Push-based 모니터링**이라고 합니다. 각 서버는 특정 역할을 가지므로 역할에 맞는 메트릭을 수집하도록 별도의 설정이 필요할 수도 있습니다.

반면 쿠버네티스 환경의 모니터링은 애플리케이션의 단위가 작아지고, (하나의 노드에 다양한 애플리케이션의 인스턴스가 실행됩니다) 모니터링 대상도 동적으로 변경될 수 있습니다. 스케일링(Scaling)이나 자동 회복(Auto Healing에 의하여 노드를 역할을 구분하기 어렵고, 컨테이너가 동적으로 생성되고 삭제되는 경우 애이전트를 설치하는 것도 쉽지 않습니다. 이러한 환경에서는 **모니터링 백엔드가 모니터링 대상을 찾고 모니터링 메트릭을 수집해오는 것**이 적절할 수도 있습니다. 이를 **Pull-based 모니터링**이라고 합니다.

### 1.2 Pull-based vs Push-based 모니터링

The choice between pull and push-based monitoring significantly impacts how you collect telemetry data in Kubernetes.

#### Pull-based 모니터링 (권장)

**Prometheus** exemplifies the **pull-based monitoring approach**. Prometheus discovers services through the Kubernetes API server and scrapes metrics from each target.

**장점 (Advantages):**

- 🔄 **Dynamic Environment Support**: Automatically detects Pod creation/deletion
- ⚙️ **Centralized Configuration**: Single point of configuration management
- 🔁 **Retry Capability**: Can retry failed scrapes during network issues
- 📊 **Lower Target Load**: Targets don't need to actively push metrics

```yaml
# Prometheus ServiceMonitor example
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: app-metrics
spec:
  selector:
    matchLabels:
      app: my-application
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

#### Push-based 모니터링

In push-based monitoring, applications and agents actively send data to the monitoring backend.

**단점 (Challenges):**

- 🔧 **Complex Agent Management**: Difficult to manage agents in dynamic environments
- 🎛️ **Individual Configuration**: Each target requires separate configuration
- ⚠️ **Data Loss Risk**: Potential data loss during network failures

**When to Use Push:**
- **Logs**: Real-time log streaming (Promtail → Loki)
- **Traces**: Trace spans sent as they occur (OpenTelemetry → Tempo)
- **Short-lived Jobs**: Batch jobs that can't be scraped
## 2. 쿠버네티스 모니터링 아키텍처

### 2.1 쿠버네티스 모니터링의 두 가지 파이프라인(Pipeline)

먼저 쿠버네티스 모니터링 아키텍처를 먼저 살펴보겠습니다. 쿠버네티스 모니터링을 **쿠버네티스(혹은 컨트롤 플레인)의 컴포넌트가 직접 활용하는 정보**와 이보다 **많은 정보를 수집해 히스토리/통계 정보를 보여주는 모니터링 시스템 관점**으로 나뉘어봅니다.

이 둘을 쿠버네티스 공식 사이트에서는 **리소스 메트릭 파이프라인(Resource Metrics Pipeline)**과** 완전한 메트릭 파이프라인(Full Metrics Pipeline)**로 구분하여 설명하고 있습니다. 일반 문서에서는 이를 코어 메트릭 파이프라인(Core Metric Pipeline)과 모니터링 파이프라인(Monitoring Pipeline)으로 부르기도 합니다.

### 2.1.1 리소스 메트릭 파이프라인 (Resource Metrics Pipeline)

**리소스 메트릭 파이프라인은 쿠버네티스의 컴포넌트가 활용하는 메트릭의 흐름**입니다. 쿠버네티스는 수집된 정보를 kubectl top 명령으로 노출해주고, 스케일링이 설정되어 있다면 자동 스케일링(Autoscaling)에 활용합니다. 아래 그림은 metrics-server를 통해 수집된 모니터링 정보를 메모리에 저장하고 API 서버를 통해 노출해 kubectl top, scheduler, HPA와 같은 오브젝트에서 사용된다는 것을 나타냅니다.

**구성 요소:**

- **kubelet**: 각 노드에서 실행되는 에이전트
- **cAdvisor**: 컨테이너 메트릭 수집기 (kubelet에 내장)
- **metrics-server**: 클러스터 전체의 리소스 사용량 집계
- **Metrics API**: kubectl top, HPA 등에서 사용
### 2.1.2 완전한 메트릭 파이프라인 (Full Metrics Pipeline)

다만 이러한 정보는 순간의 정보를 가지고 있고, 다양한 정보를 수집하지 않으며, 장시간 저장하지 않습니다. 이로 인해 두 번째 흐름인 완전한 메트릭 파이프라인이 필요합니다. 이는 기본 메트릭뿐만 아니라 다양한 메트릭을 수집하고, 이를 스토리지에 저장합니다. 완전한 메트릭 파이프라인은 쿠버네티스에서 직접 관여하지 않고, CNCF 프로젝트 중 하나인 프로메테우스를 활용할 수 있습니다.

### 2.2 모니터링 컴포넌트 소개

지금까지 살펴본 파이프라인에 다양한 모니터링 컴포넌트가 등장해 왔는데, 이를 간단히 정리해보면 다음과 같습니다.

### 핵심 컴포넌트

- **cAdvisor**: kubelet에 포함되어 노드, 파드, 컨테이너의 리소스 사용률을 수집하는 모듈
- **metrics server**: cAdvisor로부터 정보를 수집하는 도구, 리소스 메트릭 파이프라인은 metrics server의 정보를 활용함
- **Prometheus**: 서비스 디스커버리, 메트릭 수집(Scrape) 및 저장(TSDB), 쿼리 기능(PromQL 사용), Alert 기능을 제공하는 도구
- **Grafana**: 데이터 시각화 도구(Prometheus를 데이터 소스로 지정)
- **node exporter**: Prometheus와 연동되는 수집기(Exporter) 중 하나로 노드의 HW, OS 메트릭을 수집하기 위한 도구
- **kube-state-metrics**: API 서버를 통해 얻은 쿠버네티스 오브젝트의 메트릭을 생성하는 도구 (ex. 파드 현재 상태, 서비스 상태)
- **metricbeat**: kube-metric-server 및 로컬 머신, docker, kubelet에서 수집한 정보를 ElasticSearch 기반의 백엔드로 전송하는 도구
리소스 메트릭 파이프라인에 해당하는 cAdvisor와 metrics server, 각 클러스터 단위의 모니터링 시스템을 위한 Prometheus, Grafana, node exporter, kube-state-metric이 있습니다. 추가로 ElasticSearch를 백엔드로 사용하는 경우 metricbeat를 활용할 수도 있습니다.

## 3. 무엇을 모니터링 해야 할까?

쿠버네티스 환경에서 발생할 수 있는 이슈 상황의 예시 몇 가지를 들어보겠습니다.

1. 특정 노드가 다운되거나 Ready 상태가 아닌 경우 (컨트롤 플레인이 다중화되거나, 애플리케이션이 디플로이먼트와 같은 단위로 구성된 경우 보통은 큰 문제가 되지 않지만, 특정 상황에서는 문제가 될 수 있습니다.)
1. 컨트롤 플레인의 주요 컴포넌트 상태가 비정상적인 경우
1. 노드의 가용한 리소스보다 리소스 요청량(Request)이 커서 파드가 배포되지 않는 경우
1. 노드 리소스가 부족하여 컨테이너의 크래시(혹은 eviction)가 발생한 경우
1. 특정 컨테이너가 OOMKilled나 그 밖의 문제로 인해 반복적으로 재시작하는 경우
1. PV로 할당하여 마운트된 파일시스템의 용량이 부족한 경우
이를 통해 쿠버네티스를 모니터링하는 것은 OS 레벨에서 쿠버네티스, 외부 자원(스토리지)까지 범위가 넓어진다는 것을 알 수 있습니다. 이를 바탕으로 클러스터 운영자가 모니터링해야 할 부분은 아래와 같습니다.

### 3.1 클러스터 구성요소(노드 및 주요 컴포넌트)의 상태

쿠버네티스 환경이면 쿠버네티스 자체를 모니터링해야 합니다. 컨트롤 플레인의 구성요소에 문제가 발생되어 사용자 애플리케이션이 배포되지 않거나 컨트롤러가 수행해야 하는 동작이 실패하는 상황이 발생할 수 있습니다. 클러스터의 주요 컴포넌트와 더불어 노드의 상태도 확인이 필요하여 각 Healthy, Ready 상태이어야 합니다.

**모니터링 대상:**

1. **컨트롤 플레인 컴포넌트**
1. **워커 노드**
### 3.2 노드의 리소스 가용량

특정 노드에 관한 파드의 스케줄링은 노드에 할당되지 않은 리소스가 남아 있는 경우에 대해 가능합니다. 노드의 리소스 사용량 지표는 스케줄러가 수행하는 파드 스케줄링과 상관이 없습니다. 즉, 노드 가용량을 모니터링해야 하는 이유는 전체 노드에 가용한 리소스(Allocatable)가 파드의 요청량(Request)보다 부족하면 파드가 더 이상 스케줄링되지 못하기 때문입니다.

### 3.3 노드의 리소스 사용량

OS 레벨의 모니터링을 하고 있다면, sar 혹은 유사 메트릭으로 노드 리소스 사용량을 모니터링할 수 있습니다. (단, sar 등의 리소스 사용량이 kubectl top node와 결과가 완전히 일치하지 않습니다)

**cAdvisor 메트릭 활용:**

- `memory.usage_in_bytes`: 실제 메모리 사용량
- `cpu.usage_rate`: CPU 사용률
- `/proc/meminfo`: OS 레벨 메모리 정보
쿠버네티스에서는 노드의 MemoryPressure, DiskPressure가 발생하는 경우 노드 컨디션이 변경되고 파드 eviction이 발생합니다. 이는 아래값을 참조하므로 이 이상으로 노드의 리소스가 유지되도록 모니터링이 필요합니다.

- `memory.available < 100Mi`
- `nodefs.available < 10%`
- `nodefs.inodesFree < 5%`
- `images.available < 15%`
**모니터링 항목:**

- CPU/메모리 Allocatable vs Used
- 디스크 사용량 및 inode 사용량
- 네트워크 I/O
- 스토리지 I/O
### 3.4 워크로드(Workload) 이슈

애플리케이션 자체 모니터링을 언급하지는 않았지만, 애플리케이션 프로세스 다음을 모니터링하는 부분이 있습니다. 파드에 설정한 라이브니스 프로브(liveness probe)가 설정되어 있는 경우, 혹은 OOMKilled되는 경우는 컨테이너의 재시작 횟수(Restart Count)가 지속적으로 증가하는지 모니터링해 볼 수 있습니다.

파드에서 한 가지 더 이야기하고 싶은 것은 PV입니다. 특정 애플리케이션은 PV의 용량 부족이 문제가 될 수 있습니다. PV를 뒷받침하는 기반스토리지는 인프라 차원에서 관리되므로 스토리지에서 용량을 관리하고 모니터링 시스템으로 전송할 수 있습니다. 한편, PV는 파드가 실행 중인 노드에 마운트되므로, (파일시스템 모니터링이 동적으로 반영된다면) 노드의 파일시스템 모니터링으로 가능합니다.

**모니터링 항목:**

1. **Pod 상태**
1. **리소스 사용량**
1. **애플리케이션 메트릭**
## 4. node-exporter와 kube-state-metrics의 소속

### 4.1 node-exporter

- **소속**: Prometheus 프로젝트
- **역할**: 노드(호스트) 레벨의 하드웨어/OS 메트릭 수집
- **배포**: DaemonSet으로 각 노드에 배포
- **동작**: HTTP 엔드포인트(/metrics)로 메트릭 노출 → Prometheus가 pull
### 4.2 kube-state-metrics

- **소속**: Kubernetes SIG Instrumentation 프로젝트 (쿠버네티스 공식)
- **역할**: Kubernetes API로부터 오브젝트 상태 정보를 메트릭으로 변환
- **배포**: 단일 Deployment로 배포 (보통 kube-system 네임스페이스)
- **동작**: HTTP 엔드포인트(/metrics)로 메트릭 노출 → Prometheus가 pull
```yaml
# kube-state-metrics 예시
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kube-state-metrics
  template:
    spec:
      containers:
      - name: kube-state-metrics
        image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.10.0
        ports:
        - containerPort: 8080# /metrics 엔드포인트
```

## 5. 각 컴포넌트의 데이터 수집 방식

### Pull-based (Prometheus 방식)

```plain text
Prometheus Server → Target Endpoints (/metrics)
```

### Push-based vs Pull-based 분석

### 6. 상세 분석

### OpenTelemetry (Push-based)

```yaml
# OpenTelemetry는 명확히 Push 방식
Application → OTel SDK → OTel Collector → Backend (Tempo/Prometheus/Loki)

# 애플리케이션 코드에서
span = tracer.start_span("operation")
# 자동으로 Collector로 push됨
```

### Promtail (Push-based)

```yaml
# Promtail 설정 예시
clients:
  - url: http://loki:3100/loki/api/v1/push  # Push to Loki

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
# 로그 파일을 읽어서 Loki로 push
```

### 왜 이런 차이가 있을까?

**메트릭 (Pull 방식이 적합한 이유):**

- 정형화된 데이터 (숫자 값)
- 주기적 수집이 효율적
- Target discovery가 용이
- 네트워크 장애 시 재시도 가능
**로그/트레이스 (Push 방식이 적합한 이유):**

- 이벤트 기반 데이터 (발생 시점이 중요)
- 실시간 전송 필요
- 데이터 볼륨이 크고 비정형
- 버퍼링과 배치 처리 필요
# 구현

## Tracing

> Opentelemetry와 Tempo, Grafana를 통해 트레이싱 시스템을 구성한다.

### Opentelemetry Java Agent

- 트레이싱 데이터를 Instrumentation 형식으로 수집
- 애플리케이션 코드를 직접 수정하지 않고도 자동으로 메소드 호출, HTTP 요청, 데이터베이스 쿼리 등을 모니터링
> 데이터 흐름

1. 수집(Instrumentation)
1. 처리 및 컨텍스트 전파
1. 내보내기(Exporting)
### Python

Python에는 두 가지 방식이 있으며, 후자를 사용

1. **Opentelemetry Auto-instrumentation**
```docker
# opentelemetry 관련 패키지 설치
RUN pip install opentelemetry-distro opentelemetry-exporter-otlp
RUN opentelemetry-bootstrap -a install

# 환경 변수 설정
ENV OTEL_SERVICE_NAME=fastapi-application
ENV OTEL_TRACES_EXPORTER=otlp
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317

# python HTTP 클라이언트 라이브러리 -> 자동 계측 비활성화 OTEL 사용
ENV OTEL_PYTHON_DISABLED_INSTRUMENTATIONS=urllib3

# opentelemetry-instrument 명령어로 애플리케이션 실행
CMD ["opentelemetry-instrument", "python3", "main.py", "dev", ":"]
```

1. **Instrumentator**
### OpenTelemetry Collector

- 데이터 파이프라인 역할
- 다양한 형식(OTLP, Jaeger, Zipkin 등)의 원격 측정 데이터를 수집 (receive)
- 데이터를 처리, 변환, 필터링 (process)
- 다양한 백엔드 시스템으로 데이터를 전송 (export) -> 로그, 메트릭, 트레이싱 모두 수집 및 전송 가능
- 일시적인 데이터 버퍼링 및 배치 처리 지원 -> 애플리케이션 부하 감소 및 데이터 손실 방지
- 인증 및 인가 계층으로서의 역할도 가능
### Tempo

- Grafana Labs의 분산 트레이싱 백엔드
- 트레이스 데이터의 영구 스토리지 역할
- 트레이스 데이터 쿼리 및 검색 기능
> Agent는 Exporter, Collector는 Receiver + Collector는 Exporter, Tempo는 Receiver

**애플리케이션(Agent가 계측) -> Agent의 OTLP Exporter -> OpenTelemetry Collector의 OTLP Receiver -> 백엔드 서스템 (Tempo)**

## 필요한 적용 사항

1. 애플리케이션 (Spring, FastAPI) Dockerfile 수정
1. Otel-Collector, Tempo helm install
1. DAP Grafana에 대시보드 구성
## Metrics

### Prometheus

- global scraping 주기를 설정할 수 있음
- Pull 방식을 기본으로 메트릭 수집, 시계열 데이터베이스에 저장 (TSDB)
- config_out에 prometheus.env.yaml에서 scraping_interval을 확인할 수 있음 (default: 15s)
- 또한 job 별로 (servicemonitor, podmonitor) scraping interval이나 설정을 다르게 할 수 있음
- 아래는 prometheus container에 주입된 config 예시
```yaml
args:
  - --web.console.templates=/etc/prometheus/consoles
  - --web.console.libraries=/etc/prometheus/console_libraries
  - --config.file=/etc/prometheus/config_out/prometheus.env.yaml
  - --web.enable-lifecycle
  - --web.external-url=https://rancher.kube.test.nhbank/k8s/clusters/c-m-lprrjcv6/api/v1/namespaces/cattle-monitoring-system/services/http:rancher-monitoring-prometheus:9090/proxy
  - --web.route-prefix=/
  - --storage.tsdb.wal-compression
  - --storage.tsdb.retention.time=10d
  - --storage.tsdb.retention.size=40GiB
  - --storage.tsdb.path=/prometheus
  - --web.config.file=/etc/prometheus/web_config/web-config.yaml
  - --storage.tsdb.max-block-duration=2h
  - --storage.tsdb.min-block-duration=2h

```

- 단일 노드 시스템으로 설계되어 클러스터링 구조를 직접 지원하지 않음 -> 확장성, 고가용성에 보완이 필요함
- 확장성 문제
- 고가용성
### thanos

- thanos sidecar
- thanos store gateway
- thanos query
- thanos compactor
- thanos ruler
## Logging

### Loki

- 로그 에이전트의 promtail을 통해서 로그를 수집 (1차 버퍼, 실시간 수집 역할, 정확히는 promtail이 loki의 ingester로 push)
- ingester는 2차 버퍼 역할로 promtail에서 받은 로그 스트림을 받아 압축해서 청킹
- 시간 순서대로 gzip, lz4 등의 형태로 압축해서(compactor) 여러 조건에 따라 Object Storage로 저장 (최적화 역할)
- promtail은 수집한 로그의 크기가 `clients.batch_size`를 초과하거나 시간이 `clients.batch_wait`만큼 지나면 loki의 api를 통해 로그를 푸시함
- promtail은 `scrape_configs`의 `pipeline_stages.multiline.max_wait_time`을 통해서 로그 수집 대기 시간을 설정할 수 있음
- loki는 `ingester.chunk_idle_period`, `ingester.chunk_retain_period`를 통해 promtail이 보내는 로그 청크의 유효 기간, 보관 시간을 조정할 수 있음
- 청크는 시간 여시는 `ingestion_rate_mb`, `ingestion_burst_size_mb`를 통해 로그당 수집 가능한 크기, 버스트 크기를 구별 수 있음
- compactor는 object storage에 저장된 로그를 더 효율적으로 저장함
### 청크

- 특정 기간 동안의 로그 라인 스트림의 컨테이너 (unique set of labels)
- Chunk Format
```docker
----------------------------------------------------------------------------
|                        |                       |                         |
|     MagicNumber(4b)    |     version(1b)       |      encoding (1b)      |
|                        |                       |                         |
----------------------------------------------------------------------------
|                      #structuredMetadata (uvarint)                       |
----------------------------------------------------------------------------
|      len(label-1) (uvarint)      |          label-1 (bytes)              |
----------------------------------------------------------------------------
|      len(label-2) (uvarint)      |          label-2 (bytes)              |
----------------------------------------------------------------------------
|      len(label-n) (uvarint)      |          label-n (bytes)              |
----------------------------------------------------------------------------
|                      checksum(from #structuredMetadata)                  |
----------------------------------------------------------------------------
|           block-1 bytes          |           checksum (4b)               |
----------------------------------------------------------------------------
|           block-2 bytes          |           checksum (4b)               |
----------------------------------------------------------------------------
|           block-n bytes          |           checksum (4b)               |
----------------------------------------------------------------------------
|                           #blocks (uvarint)                              |
----------------------------------------------------------------------------
| #entries(uvarint) | mint, maxt (varint)  | offset, len (uvarint)         |
----------------------------------------------------------------------------
| #entries(uvarint) | mint, maxt (varint)  | offset, len (uvarint)         |
----------------------------------------------------------------------------
| #entries(uvarint) | mint, maxt (varint)  | offset, len (uvarint)         |
----------------------------------------------------------------------------
| #entries(uvarint) | mint, maxt (varint)  | offset, len (uvarint)         |
----------------------------------------------------------------------------
|                          checksum(from #blocks)                          |
----------------------------------------------------------------------------
| #structuredMetadata len (uvarint) | #structuredMetadata offset (uvarint) |
----------------------------------------------------------------------------
|     #blocks len (uvarint)         |       #blocks offset (uvarint)       |
----------------------------------------------------------------------------
```

- `mint`, `maxt` 는 최대, 최소 Unix nanosecond 단위 타임스탬프
- `structuredMetadata` 는 반복되지 않는 문자열을 저장함
- label의 이름과 값을 저장하는데 사용됨 (압축된 채로 저장됨)
### Block

- 이 엔트리 각각이 로그 하나
```docker
-----------------------------------------------------------------------------------------------------------------------------------------------
|  ts (varint)  |  len (uvarint)  |  log-1 bytes  |  len(from #symbols)  |  #symbols (uvarint)  |  symbol-1 (uvarint)  | symbol-n*2 (uvarint) |
-----------------------------------------------------------------------------------------------------------------------------------------------
|  ts (varint)  |  len (uvarint)  |  log-2 bytes  |  len(from #symbols)  |  #symbols (uvarint)  |  symbol-1 (uvarint)  | symbol-n*2 (uvarint) |
-----------------------------------------------------------------------------------------------------------------------------------------------
|  ts (varint)  |  len (uvarint)  |  log-3 bytes  |  len(from #symbols)  |  #symbols (uvarint)  |  symbol-1 (uvarint)  | symbol-n*2 (uvarint) |
-----------------------------------------------------------------------------------------------------------------------------------------------
|  ts (varint)  |  len (uvarint)  |  log-n bytes  |  len(from #symbols)  |  #symbols (uvarint)  |  symbol-1 (uvarint)  | symbol-n*2 (uvarint) |
-----------------------------------------------------------------------------------------------------------------------------------------------
```

## Ingress Controller

### Nginx Ingress Controller

### Nginx Ingress Controller Pod

### Processing a new Ingress

When Ingress configurations change, the controller pod's nginx.conf settings are automatically updated through the following mechanism:

- **Controller Detection**: NGINX Ingress Controller uses watch API for detection (Long Polling, SSE)
- **Event Monitoring**: Watch API monitors Ingress change events coming to kube-apiserver
- **Configuration**: NGINX Ingress Controller pod includes setting `-watch-ingress-without-class=true`

## Resource Cache

The controller maintains a resource cache to efficiently handle configuration updates and reduce API server load.

---

## Conclusion

Building a comprehensive monitoring solution for Kubernetes requires understanding the unique challenges of container orchestration and implementing the right combination of tools:

### Key Takeaways

1. **Embrace Pull-based Monitoring**: For dynamic Kubernetes environments, pull-based systems like Prometheus offer better service discovery and resilience.

2. **Implement All Three Pillars**: 
   - **Metrics** (Prometheus + Grafana) for quantitative analysis
   - **Logs** (Loki + Promtail) for event debugging
   - **Traces** (Tempo + OpenTelemetry) for distributed system understanding

3. **Monitor at Multiple Levels**:
   - Cluster components and health
   - Node resource utilization
   - Workload performance and availability

4. **Automate Everything**: Use operators, service discovery, and GitOps principles to manage your monitoring stack as code.

### Next Steps

- Set up **kube-prometheus-stack** for comprehensive metrics and alerting
- Implement **OpenTelemetry** for distributed tracing
- Configure **Loki** for centralized logging
- Build custom dashboards and alerts for your specific workloads

The investment in proper observability pays dividends in faster incident resolution, proactive issue detection, and overall system reliability.

---

*This comprehensive guide covers the essential components for monitoring production Kubernetes environments. For specific implementation details, refer to the individual component documentation and consider your infrastructure requirements.*

*Originally published in [Notion](https://www.notion.so/Kubernetes-Monitoring-Tracing-Logging-Monitoring-1cfeef64a1ca80ef955ce037e530e2c5) on April 08, 2025*
