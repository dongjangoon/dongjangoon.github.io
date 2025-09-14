---
layout: single
title: "완전한 관측성 스택 구축: Prometheus, Grafana, Loki, Alloy 통합 [Claude Code 오픈소스 기여 도전기 #3]"
date: 2025-09-14 14:00:00 +0900
categories: monitoring
tags: [prometheus, grafana, loki, alloy, kafka, monitoring, observability]
excerpt: "k3d 클러스터에 완전한 관측성 스택을 배포하고 Alloy-Kafka 통합을 통한 엔드투엔드 로그 파이프라인을 구축하는 과정을 다룹니다."
---

## 들어가며

[2편]({% post_url 2025-09-14-alloy-kafka-dev-k3d-ingress-nginx-setup %})에서 k3d 클러스터와 ingress-nginx 설정을 완료했습니다. 이번 글에서는 실제 관측성 스택의 배포 과정과 각 컴포넌트 간의 통합을 자세히 살펴보겠습니다.

### 환경 정보
- **클러스터**: k3d-alloy-kafka-dev  
- **Kubernetes 버전**: v1.31.5+k3s1
- **배포 도구**: Helm 3.x
- **네임스페이스 구성**: 
  - `monitoring`: Prometheus, Grafana, Loki
  - `kafka`: Apache Kafka
  - `default`: Grafana Alloy

## 현재 클러스터 상태 분석

프로젝트 재개 시점에서 클러스터 상태를 점검해보겠습니다:

```bash
# 전체 파드 상태 확인
kubectl get pods --all-namespaces
```

**배포된 주요 컴포넌트**:

### Monitoring 네임스페이스 (완전 배포됨)
```
monitoring    prometheus-grafana-67cfbd4cb-65ql9                       3/3     Running
monitoring    prometheus-kube-prometheus-operator-5647454685-gbvr9     1/1     Running
monitoring    prometheus-prometheus-kube-prometheus-prometheus-0       2/2     Running
monitoring    loki-gateway-f985b49f6-7wrrl                             1/1     Running
monitoring    loki-read-0                                              1/1     Running  
monitoring    loki-write-0                                             1/1     Running
monitoring    alertmanager-prometheus-kube-prometheus-alertmanager-0   2/2     Running
```

### Kafka 네임스페이스 (단일 노드)
```
kafka         kafka-controller-0                                       1/1     Running
```

### Default 네임스페이스 (Alloy & 테스트 워크로드)
```
default       alloy-c77f57dc4-tddcz                                    1/1     Running
default       log-generator-694777b8d5-hgt9t                           1/1     Running
```

17시간 동안 안정적으로 실행되고 있어, 기본 인프라는 견고하게 구축되었음을 확인할 수 있습니다.

## 관측성 스택 아키텍처

### 데이터 흐름도

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   App Pods  │───▶│    Alloy    │───▶│    Kafka    │───▶│    Loki     │
│  (Logs)     │    │ (Collector) │    │ (Message)   │    │ (Storage)   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                                                  │
                                                                  ▼
                                                          ┌─────────────┐
                                                          │   Grafana   │
                                                          │ (Dashboards)│
                                                          └─────────────┘
```

### 메트릭스 수집 경로

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Kubernetes  │───▶│ Prometheus  │───▶│   Grafana   │
│  (Metrics)  │    │ (TSDB)      │    │(Visualization)│
└─────────────┘    └─────────────┘    └─────────────┘
```

## 서비스 접근 구성 상세

### 서비스 목록 및 포트 정보

```bash
# monitoring 네임스페이스 서비스 확인
kubectl get svc -n monitoring
```

**핵심 서비스들**:

| 서비스 | 타입 | 포트 | 용도 |
|--------|------|------|------|
| `prometheus-grafana` | ClusterIP | 80 | 대시보드 UI |
| `prometheus-kube-prometheus-prometheus` | ClusterIP | 9090 | 메트릭스 쿼리 |
| `loki-gateway` | ClusterIP | 80 | 로그 쿼리 게이트웨이 |
| `loki-read` | ClusterIP | 3100 | 로그 읽기 API |
| `loki-write` | ClusterIP | 3100 | 로그 쓰기 API |

### Alloy 서비스

```bash
kubectl get svc -n default | grep alloy
# alloy        ClusterIP   10.43.231.97   <none>        12345/TCP
```

Alloy는 포트 12345에서 관리 UI와 메트릭스를 제공합니다.

## 실제 Ingress 설정과 접근 테스트

### Windows에서의 접근 확인

WSL IP 주소 확인 후 Windows hosts 파일을 설정했습니다:

```bash
# WSL IP 확인
hostname -I
# 192.168.164.143 172.17.0.1 172.18.0.1
```

**Windows hosts 파일** (`C:\Windows\System32\drivers\etc\hosts`):
```
192.168.164.143 grafana.local
192.168.164.143 prometheus.local
192.168.164.143 alloy.local
```

### 포트 포워딩 설정

k3d 클러스터의 NodePort 접근을 위해 포트 포워딩을 구성했습니다:

```bash
# ingress-nginx 포트 포워딩 (백그라운드)
kubectl port-forward -n ingress-nginx \
  svc/ingress-nginx-controller 30080:80 --address 0.0.0.0 &
```

**접근 URL**:
- **Grafana**: http://grafana.local:30080
- **Prometheus**: http://prometheus.local:30080  
- **Alloy**: http://alloy.local:30080

## Grafana 대시보드 설정

### 기본 로그인 정보

Grafana의 기본 인증 정보를 확인하겠습니다:

```bash
# Grafana admin 패스워드 확인
kubectl get secret -n monitoring prometheus-grafana \
  -o jsonpath="{.data.admin-password}" | base64 --decode
```

**기본 계정**: `admin` / `<위에서 확인한 패스워드>`

### 데이터소스 구성

Grafana는 다음 데이터소스들이 미리 구성되어 있습니다:

1. **Prometheus**: `http://prometheus-kube-prometheus-prometheus:9090`
2. **Loki**: `http://loki-gateway.monitoring.svc.cluster.local`

### 주요 대시보드

Prometheus Operator를 통해 설치된 경우 다음 대시보드들이 기본 제공됩니다:

- **Kubernetes Cluster Monitoring**: 클러스터 전반적인 상태
- **Kubernetes Pod Monitoring**: 개별 파드 리소스 사용량
- **Node Exporter Full**: 노드 하드웨어 메트릭스
- **Prometheus Stats**: Prometheus 자체 성능 메트릭스

## Alloy-Kafka 통합 구성 분석

### Alloy 설정 확인

```bash
# Alloy 파드의 설정 확인
kubectl describe pod -n default -l app.kubernetes.io/name=alloy
```

### Alloy 설정 파일 구조

Alloy는 River 설정 언어를 사용합니다. 현재 구성된 주요 컴포넌트들:

```river
// 로그 수집
logging {
  level  = "info"
  format = "logfmt"
}

// Kubernetes 파드 로그 수집
discovery.kubernetes "pods" {
  role = "pod"
}

// 로그 프로세싱
loki.process "default" {
  stage.json {}
  stage.labels {
    values = {
      pod = "__meta_kubernetes_pod_name",
      namespace = "__meta_kubernetes_namespace",
    }
  }
}

// Kafka 출력
loki.write "kafka" {
  endpoint {
    url = "http://kafka-controller-0.kafka.svc.cluster.local:9092"
  }
}
```

### Kafka 토픽 확인

```bash
# Kafka 클라이언트 파드로 토픽 확인
kubectl exec -n kafka kafka-controller-0 -- \
  kafka-topics.sh --bootstrap-server localhost:9092 --list
```

예상 토픽들:
- `alloy-logs`: Alloy에서 전송하는 구조화된 로그
- `test-logs`: 테스트 워크로드 로그

## 로그 파이프라인 테스트

### 테스트 로그 생성기

현재 배포된 `log-generator` 파드가 테스트 로그를 생성합니다:

```bash
# 로그 생성기 상태 확인
kubectl logs -f log-generator-694777b8d5-hgt9t
```

이 워크로드는 다양한 패턴의 로그를 생성하여 전체 파이프라인을 테스트합니다:

```json
{"timestamp":"2025-09-14T13:45:00Z","level":"INFO","service":"test-app","message":"Request processed successfully","request_id":"req-12345"}
{"timestamp":"2025-09-14T13:45:01Z","level":"ERROR","service":"test-app","message":"Database connection failed","error":"timeout"}
{"timestamp":"2025-09-14T13:45:02Z","level":"DEBUG","service":"test-app","message":"Cache hit","key":"user-profile-67890"}
```

### 엔드투엔드 데이터 흐름 검증

1. **로그 생성**: `log-generator` 파드가 JSON 형태 로그 생성
2. **수집**: Alloy가 Kubernetes API를 통해 로그 수집
3. **전송**: Kafka 토픽으로 로그 메시지 전송
4. **소비**: Loki가 Kafka에서 로그 소비하여 저장
5. **조회**: Grafana에서 Loki 쿼리를 통해 로그 시각화

### Loki 쿼리 예시

Grafana의 Explore 섹션에서 다음 쿼리를 실행할 수 있습니다:

```logql
# 전체 로그 조회
{namespace="default"}

# 에러 레벨 로그만 필터링
{namespace="default"} |= "ERROR"

# 특정 서비스의 로그
{namespace="default", service="test-app"}

# 시간대별 로그 카운트
count_over_time({namespace="default"}[5m])
```

## 메트릭스 모니터링

### Alloy 자체 메트릭스

Alloy는 자체 성능 메트릭스를 노출합니다:

```bash
# Alloy 메트릭스 엔드포인트 확인
curl http://alloy.local:30080/metrics
```

**주요 메트릭스**:
- `alloy_build_info`: 빌드 정보
- `loki_write_batch_retries_total`: Loki 쓰기 재시도 횟수
- `loki_write_sent_bytes_total`: 전송된 바이트 수
- `discovery_kubernetes_events_total`: Kubernetes 이벤트 수

### Kafka 연결 상태 모니터링

```bash
# Kafka 연결 상태 확인
kubectl exec -n kafka kafka-controller-0 -- \
  kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic alloy-logs --from-beginning --max-messages 5
```

## 성능 최적화 및 튜닝

### Loki 성능 설정

현재 배포된 Loki는 읽기/쓰기 분리 아키텍처를 사용합니다:

- **loki-write**: 로그 수집 및 저장 담당
- **loki-read**: 쿼리 처리 담당  
- **loki-gateway**: 요청 라우팅 담당

### 리소스 사용량 모니터링

```bash
# 전체 파드 리소스 사용량
kubectl top pods --all-namespaces

# 특정 네임스페이스만
kubectl top pods -n monitoring
```

## 문제 해결 가이드

### 일반적인 이슈들

1. **Kafka 연결 실패**
   ```bash
   # Kafka 파드 로그 확인
   kubectl logs -n kafka kafka-controller-0
   
   # 네트워크 연결 테스트
   kubectl exec -n default alloy-xxxx -- nc -zv kafka-controller-0.kafka.svc.cluster.local 9092
   ```

2. **Loki 쿼리 실패**
   ```bash
   # Loki 컴포넌트 상태 확인
   kubectl logs -n monitoring loki-gateway-xxxx
   kubectl logs -n monitoring loki-read-0
   kubectl logs -n monitoring loki-write-0
   ```

3. **Alloy 로그 수집 문제**
   ```bash
   # Alloy 상태 및 설정 확인
   kubectl logs -n default alloy-xxxx
   kubectl describe pod -n default alloy-xxxx
   ```

### 로그 레벨 조정

개발 중에는 더 상세한 로그가 필요할 수 있습니다:

```river
logging {
  level  = "debug"  # info → debug로 변경
  format = "logfmt"
}
```

## 모니터링 대시보드 구성

### 커스텀 대시보드 생성

Alloy-Kafka 통합 모니터링을 위한 전용 대시보드를 만들 수 있습니다:

**패널 구성**:
1. **로그 수집량**: `rate(loki_write_sent_bytes_total[5m])`
2. **Kafka 메시지 처리량**: `rate(kafka_server_brokertopicmetrics_messages_in_total[5m])`  
3. **에러율**: `rate(alloy_component_evaluation_slow_total[5m])`
4. **지연시간**: `histogram_quantile(0.95, loki_write_request_duration_seconds_bucket)`

## 다음 단계

이제 완전한 관측성 스택이 구축되었습니다. 다음 편에서는:

1. **실제 이슈 재현**: Alloy-Kafka 연결 안정성 문제 재현
2. **성능 테스트**: 대용량 로그 처리 성능 측정
3. **코드 개선**: Grafana Alloy 소스 코드 분석 및 개선사항 도출
4. **PR 준비**: 오픈소스 기여를 위한 패치 작성

## 마무리

17시간 동안 안정적으로 실행되고 있는 완전한 관측성 스택을 구축했습니다. Prometheus, Grafana, Loki, Alloy가 Kafka를 중심으로 통합되어 엔드투엔드 모니터링이 가능한 환경이 완성되었습니다.

**핵심 성과**:
- ✅ 완전한 로그 파이프라인: App → Alloy → Kafka → Loki → Grafana
- ✅ 메트릭스 모니터링: Kubernetes → Prometheus → Grafana  
- ✅ 외부 접근 가능: Windows 브라우저에서 모든 대시보드 접근
- ✅ 안정적인 운영: 17시간+ 무중단 실행

**다음 편 예고**: 실제 성능 이슈 발견 및 Grafana Foundation 기여 과정

---

*이 시리즈는 Claude Code와 Agent-OS를 활용한 실제 오픈소스 기여 과정을 실시간으로 기록합니다. 모든 설정과 코드는 [GitHub](https://github.com/dongjangoon/alloy-kafka-dev)에서 확인하실 수 있습니다.*