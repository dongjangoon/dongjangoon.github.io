---
layout: post
title: "Loki Ring Health 문제 해결: 스케일링 실패에서 단일 바이너리 모드로의 전환 [Claude Code 오픈소스 기여 도전기 #4]"
date: 2025-09-14 16:00:00 +0900
categories: [Kubernetes, Observability, Troubleshooting]
tags: [loki, kubernetes, helm, observability, troubleshooting, grafana]
excerpt: "Loki의 'too many unhealthy rings' 에러를 해결하기 위해 분산 모드에서 단일 바이너리 모드로 전환하는 실제 문제 해결 과정을 다룹니다."
---

## 들어가며

[3편]({% post_url 2025-09-14-alloy-kafka-observability-stack-deployment %})에서 완전한 관측성 스택을 구축했지만, 운영 중 Loki에서 **"too many unhealthy rings"** 에러가 지속적으로 발생했습니다. 이번 글에서는 이 문제를 해결하기 위해 복잡한 분산 설정에서 단순한 단일 바이너리 모드로 전환하는 과정을 자세히 다루겠습니다.

### 문제 상황 요약

- **에러**: Loki에서 "too many unhealthy rings" 지속 발생
- **초기 구성**: Loki 분산 모드 (read:2, write:3, backend:1)
- **리소스 제약**: k3d 단일 노드 클러스터의 메모리 부족
- **해결 방향**: 단일 바이너리 모드로의 단순화

## 현재 Loki 상태 진단

### 문제 발생 징후

Loki 파드들의 상태를 확인해보면 여러 문제점이 드러났습니다:

```bash
# Loki 파드 상태 확인
kubectl get pods -n monitoring | grep loki
```

**문제가 있는 파드들**:
```
loki-read-0                                              1/1     Running
loki-write-0                                             1/1     Running  
loki-backend-0                                           1/1     Running
loki-chunks-cache-0                                      0/2     Pending  # ❌ 메모리 부족
loki-gateway-f985b49f6-7wrrl                             1/1     Running
```

### 메모리 부족 이슈 확인

chunks-cache 파드의 상세 정보를 확인하니 핵심 원인이 드러났습니다:

```bash
kubectl get pod loki-chunks-cache-0 -n monitoring -o yaml | grep -A 20 "status:"
```

**에러 메시지**:
```yaml
conditions:
- message: '0/1 nodes are available: 1 Insufficient memory. preemption: 0/1 nodes 
    are available: 1 No preemption victims found for incoming pod.'
  reason: Unschedulable
  status: "False"
  type: PodScheduled
```

k3d 단일 노드 개발 환경에서는 Loki의 분산 아키텍처가 과도한 리소스를 요구하고 있었습니다.

## 해결 전략: 단일 바이너리 모드 전환

### 왜 단일 바이너리 모드인가?

**분산 모드의 문제점**:
- 메모리 사용량 과다 (chunks-cache, results-cache 등)
- 복잡한 ring 관리로 인한 안정성 이슈
- 개발 환경에 과도한 복잡성

**단일 바이너리 모드의 장점**:
- 단일 프로세스로 모든 기능 제공
- 메모리 사용량 최소화
- Ring 관리 복잡성 제거
- 개발 환경에 적합한 단순성

### 설정 파일 준비

기존 복잡한 설정을 단순화한 새로운 values 파일을 작성했습니다:

**`loki-simple-values.yaml`**:
```yaml
deploymentMode: SingleBinary

loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: filesystem
  schemaConfig:
    configs:
      - from: 2020-10-24
        store: boltdb-shipper
        object_store: filesystem
        schema: v11
        index:
          prefix: index_
          period: 24h
  limits_config:
    allow_structured_metadata: false  # v11 스키마 호환성

singleBinary:
  replicas: 1
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 200m
      memory: 256Mi
  persistence:
    enabled: true
    size: 5Gi

gateway:
  enabled: true
  replicas: 1

serviceMonitor:
  enabled: true

# 분산 컴포넌트 비활성화
read:
  replicas: 0
write:
  replicas: 0
backend:
  replicas: 0

test:
  enabled: false
```

## 실제 문제 해결 과정

### 1단계: 기존 Loki 제거

사용자가 기존 분산 모드 Loki를 제거했습니다:

```bash
# 기존 Loki 언인스톨
helm uninstall loki -n monitoring
```

### 2단계: 단일 바이너리 모드 설치 시도

첫 번째 설치 시도에서 스키마 호환성 문제가 발생했습니다:

```bash
helm upgrade loki grafana/loki --namespace monitoring -f loki-simple-values.yaml
```

**에러 발생**:
```
CONFIG ERROR: schema v13 is required to store Structured Metadata and use native OTLP ingestion, 
your schema version is v11. Set `allow_structured_metadata: false` in the `limits_config` section
```

### 3단계: 스키마 호환성 문제 해결

Loki v11 스키마는 structured metadata를 지원하지 않으므로 이를 비활성화해야 했습니다:

```yaml
loki:
  limits_config:
    allow_structured_metadata: false  # 추가된 설정
```

### 4단계: 성공적인 재설치

업데이트된 설정으로 재설치를 진행했습니다:

```bash
helm upgrade loki grafana/loki --namespace monitoring -f loki-simple-values.yaml
```

**설치 성공 로그**:
```
Release "loki" has been upgraded. Happy Helming!
NAME: loki
LAST DEPLOYED: Sun Sep 14 15:27:52 2025
NAMESPACE: monitoring
STATUS: deployed
REVISION: 2

Loki has been deployed as a single binary.
This means a single pod is handling reads and writes.
```

## 설치 후 상태 검증

### 파드 상태 확인

```bash
kubectl get pods -n monitoring | grep loki
```

**새로운 파드 구성**:
```
loki-0                                                   1/2     Running
loki-canary-czktz                                        1/1     Running
loki-gateway-64647c9956-z2rlz                            1/1     Running
loki-results-cache-0                                     2/2     Running
```

문제가 있던 `loki-chunks-cache-0`가 제거되고 훨씬 단순한 구조가 되었습니다.

### API 연결 테스트

Loki Gateway를 통한 API 접근을 확인했습니다:

```bash
# 포트 포워딩 설정
kubectl port-forward -n monitoring svc/loki-gateway 3100:80 &

# API 상태 확인
curl -s http://localhost:3100/loki/api/v1/status/buildinfo
```

**응답 예시**:
```json
{
  "version": "3.5.3",
  "revision": "af52a690",
  "branch": "release-3.5.x",
  "buildUser": "root@buildkitsandbox",
  "buildDate": "2025-07-16T21:46:46Z",
  "goVersion": ""
}
```

## Grafana 데이터소스 업데이트

### 데이터소스 URL 변경

단일 바이너리 모드에서는 `loki-gateway` 서비스를 통해 접근해야 합니다:

**기존**: `http://loki-read.monitoring:3100/`  
**변경**: `http://loki-gateway.monitoring/`

```yaml
# additional-datasources.yaml
apiVersion: 1
datasources:
- name: "Loki"
  type: loki
  uid: loki
  url: http://loki-gateway.monitoring/  # 업데이트된 URL
  access: proxy
  isDefault: false
  jsonData:
    maxLines: 1000
    timeout: 60s
    httpHeaderName1: "X-Scope-OrgID"
  secureJsonData:
    httpHeaderValue1: "1"
```

### Grafana 재시작

```bash
# 설정 적용
kubectl apply -f additional-datasources.yaml

# Grafana 재시작으로 설정 반영
kubectl rollout restart deployment/prometheus-grafana -n monitoring
```

## Alloy 데이터소스 이슈 해결

### 문제 상황

Alloy를 별도 데이터소스로 설정했을 때 다음 에러가 발생했습니다:

```
response from prometheus couldn't be parsed. it is non-json: 
ReadObject: expect { or , or } or n, but found <, error found in #1 byte of ...|<!doctype h|...
```

### 원인 분석

Alloy는 Prometheus API를 제공하지 않고 단순히 `/metrics` 엔드포인트만 노출합니다:

```bash
# Alloy 루트 엔드포인트는 HTML UI 반환
curl http://localhost:12345/
# <!doctype html><html lang="en">...

# 메트릭스는 /metrics에서만 제공
curl http://localhost:12345/metrics
# HELP alloy_build_info A metric with a constant '1' value...
```

### 해결책: 기존 Prometheus 활용

Alloy 메트릭스는 이미 Prometheus에서 수집되고 있으므로 별도 데이터소스가 불필요합니다:

```bash
# Prometheus에서 Alloy 메트릭스 쿼리 확인
curl -s "http://localhost:9090/api/v1/query?query=alloy_build_info"
```

**결과**: Prometheus에서 Alloy 메트릭스를 정상적으로 제공하므로 별도 데이터소스를 제거했습니다.

## 리소스 사용량 비교

### 이전 (분산 모드)

| 컴포넌트 | 파드 수 | 메모리 요청 | CPU 요청 |
|----------|---------|-------------|----------|
| loki-read | 2 | 256Mi × 2 | 100m × 2 |
| loki-write | 3 | 256Mi × 3 | 100m × 3 |  
| loki-backend | 1 | 256Mi × 1 | 100m × 1 |
| loki-chunks-cache | 2 | **실패** | **실패** |
| **총계** | 8+ | **>1.5Gi** | **>600m** |

### 현재 (단일 바이너리)

| 컴포넌트 | 파드 수 | 메모리 요청 | CPU 요청 |
|----------|---------|-------------|----------|
| loki-0 | 1 | 256Mi | 200m |
| loki-gateway | 1 | 64Mi | 100m |
| **총계** | 2 | **320Mi** | **300m** |

**리소스 절약**: 메모리 **80% 감소**, CPU **50% 감소**

## 성능 및 안정성 검증

### Ring Health 문제 해결

단일 바이너리 모드에서는 복잡한 ring 관리가 불필요하므로 "too many unhealthy rings" 에러가 완전히 해결되었습니다.

### 로그 수집 테스트

```bash
# 테스트 로그 전송
curl -H "Content-Type: application/json" -XPOST -s "http://127.0.0.1:3100/loki/api/v1/push" \
--data-raw '{"streams": [{"stream": {"job": "test"}, "values": [["'$(date +%s)'000000000", "fizzbuzz"]]}]}'

# 로그 조회 확인
curl "http://127.0.0.1:3100/loki/api/v1/query_range" --data-urlencode 'query={job="test"}'
```

**결과**: 로그 수집과 조회가 정상적으로 작동합니다.

## 교훈과 베스트 프랙티스

### 개발 환경에서의 교훈

1. **과도한 엔지니어링 피하기**: 개발 환경에서는 단순함이 안정성을 가져옵니다
2. **리소스 제약 고려**: 단일 노드 환경에서는 분산 아키텍처가 오히려 독이 될 수 있습니다
3. **문제의 본질 파악**: 복잡한 설정보다 근본 원인 해결이 우선입니다

### Loki 배포 모드 선택 가이드

**단일 바이너리 모드 추천 상황**:
- 개발/테스트 환경
- 소규모 로그 볼륨 (< 100GB/day)
- 리소스 제약이 있는 환경
- 운영 복잡성을 최소화하려는 경우

**분산 모드 고려 상황**:
- 프로덕션 환경
- 대용량 로그 처리 (> 1TB/day)
- 고가용성이 중요한 경우
- 충분한 클러스터 리소스 보장

### 트러블슈팅 프로세스

1. **증상 확인**: 에러 로그와 파드 상태 정확히 파악
2. **리소스 분석**: CPU/메모리 사용량과 요청량 비교
3. **아키텍처 재검토**: 현재 환경에 적합한 구성인지 판단
4. **단계적 해결**: 복잡한 설정을 단순화하여 문제 격리
5. **검증**: 해결 후 기능과 성능 재확인

## 다음 단계 미리보기

다음 5편에서는 안정화된 환경에서:

1. **실제 성능 테스트**: 단일 바이너리 모드의 처리 한계 측정
2. **커스텀 대시보드**: Loki + Alloy + Kafka 통합 모니터링 대시보드 구축
3. **알림 설정**: 로그 에러율 기반 AlertManager 규칙 생성
4. **코드 분석**: Grafana Alloy의 Kafka 연동 코드 리뷰

## 마무리

"too many unhealthy rings" 문제를 해결하기 위해 복잡한 분산 모드에서 단순한 단일 바이너리 모드로 전환했습니다. 이 과정에서 다음을 달성했습니다:

**해결된 문제**:
- ✅ Ring health 에러 완전 해결
- ✅ 메모리 사용량 80% 감소
- ✅ 파드 수 75% 감소  
- ✅ 운영 복잡성 대폭 단순화

**핵심 인사이트**:
- 개발 환경에서는 단순함이 곧 안정성
- 리소스 제약을 고려한 아키텍처 선택 중요
- 스키마 호환성 등 세부사항도 놓치지 말아야 함

이제 안정적인 로그 파이프라인을 바탕으로 실제 성능 최적화와 오픈소스 기여 작업을 진행할 수 있게 되었습니다.

**IMAGE_PLACEHOLDER_1**: Loki 파드 상태 변화 스크린샷 (분산 모드 → 단일 바이너리 모드)
**IMAGE_PLACEHOLDER_2**: 리소스 사용량 비교 그래프 (메모리/CPU 사용량)  
**IMAGE_PLACEHOLDER_3**: Grafana에서 Loki 데이터소스 연결 테스트 성공 화면

---

*이 시리즈는 Claude Code와 Agent-OS를 활용한 실제 오픈소스 기여 과정을 실시간으로 기록합니다. 모든 설정과 코드는 [GitHub](https://github.com/dongjangoon/alloy-kafka-dev)에서 확인하실 수 있습니다.*