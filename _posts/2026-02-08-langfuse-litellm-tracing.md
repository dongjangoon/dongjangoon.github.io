---
layout: single
title: "Langfuse와 LiteLLM으로 LLM 트레이싱 구축하기 — Kubernetes 배포부터 Grafana Tempo 연동까지"
date: 2026-02-08 10:00:00 +0900
categories: llm-ops
tags: [langfuse, litellm, llm, tracing, observability, opentelemetry, grafana, tempo, kubernetes, helm]
excerpt: "LLM 애플리케이션은 전통적인 소프트웨어와 달리 비결정적이고, 체이닝된 호출 구조가 복잡하며, 프롬프트-응답의 품질을 정량화하기 어렵습니다. Langfuse와 LiteLLM을 Kubernetes 환경에 구축하고, OpenTelemetry 기반으로 Grafana Tempo와 연동하여 기존 모니터링 스택에 LLM 트레이싱을 통합하는 방법을 다룹니다."
---

## 들어가며

LLM 기반 서비스를 운영하다 보면 전통적인 APM 도구만으로는 부족한 순간이 옵니다. HTTP 요청의 응답 시간과 상태 코드는 볼 수 있지만, 그 안에서 "어떤 프롬프트가 들어갔고, 모델이 뭘 응답했으며, 토큰을 얼마나 소비했는지"는 보이지 않습니다. LLM은 본질적으로 비결정적(non-deterministic)이기 때문에, 같은 입력에 다른 출력이 나올 수 있고, 그 품질을 정량적으로 추적하려면 전용 도구가 필요합니다.

실제 프로젝트에서 Langchain과 Langgraph 기반의 AI 서비스를 운영하면서 이 문제를 겪었습니다. 여러 LLM을 호출하는 AgentGraph에서 어디가 병목인지, 특정 세션에서 프롬프트가 어떻게 변형되어 나가는지, 토큰 비용은 세션당 얼마나 드는지를 한눈에 보고 싶었습니다. 그때 도입한 것이 Langfuse와 LiteLLM입니다.

이 글에서는 Langfuse와 LiteLLM이 각각 어떤 역할을 하는지 살펴보고, Kubernetes(k3s) 환경에 Helm으로 배포한 뒤, OpenTelemetry를 통해 Grafana Tempo와 연동하여 기존 모니터링 스택에 LLM 트레이싱을 통합하는 과정까지 다루겠습니다.

## Langfuse — LLM 관찰성 플랫폼

### Langfuse란?

Langfuse는 오픈소스 LLM 엔지니어링 플랫폼입니다. LLM 애플리케이션의 디버깅, 분석, 개선을 위한 도구를 제공하며, 크게 세 가지 핵심 기능이 있습니다.

**Observability (관찰성)**: LLM 호출 단위의 low-level 트레이싱이 가능합니다. 각 호출의 프롬프트, 응답, 토큰 수, 지연 시간, 비용을 추적하며, Langchain/Langgraph 같은 프레임워크의 체인 구조를 계층적으로 시각화합니다. RAG의 retrieval 단계, embedding 호출, 에이전트의 tool 사용까지 모두 포착됩니다.

**Prompts (프롬프트 관리)**: 유저, 세션, input/output이 모두 기록되어 프롬프트가 어떻게 변형되고 출력되는지 추적할 수 있습니다. 프롬프트의 버전 관리와 배포가 가능하고, Playground에서 바로 테스트할 수 있으며, 트레이스와 연결하여 어떤 프롬프트 버전이 어떤 성능을 보이는지 비교할 수 있습니다.

**Evaluation (평가)**: LLM-as-a-Judge, 사용자 피드백 수집, 수동 레이블링 등 다양한 방법으로 output의 품질을 측정합니다. Dataset을 만들어 체계적으로 테스트하고, Experiment를 실행하여 프롬프트나 모델 변경의 영향을 정량적으로 비교할 수 있습니다.

### Langfuse의 데이터 모델

Langfuse의 트레이싱 구조를 이해하려면 핵심 데이터 모델을 알아야 합니다.

```
Session (세션)
└── Trace (트레이스) — 하나의 요청 처리 단위
    ├── Span — 일반적인 작업 단위 (retrieval, 전처리 등)
    │   └── Generation — LLM 호출 (모델, 토큰, 비용 자동 추적)
    ├── Generation — 직접적인 LLM 호출
    └── Span
        ├── Span — 중첩 가능
        └── Generation
```

**Trace**: 하나의 요청 처리 단위입니다. 사용자가 챗봇에 질문을 하면, 그 질문부터 답변까지의 전체 과정이 하나의 Trace입니다.

**Observation**: Trace 안의 개별 단계입니다. LLM 호출(Generation), 도구 사용, RAG 검색 등이 각각 Observation으로 기록되며, 중첩이 가능합니다.

**Session**: 멀티턴 대화처럼 여러 Trace를 하나의 세션으로 묶을 수 있습니다.

프로젝트에서 Langchain/Langgraph 기반 AgentGraph의 각 노드가 수행하는 작업이 Observation으로 기록되어, 어떤 노드에서 시간이 오래 걸리는지, 토큰 소비가 큰지를 한눈에 파악할 수 있었습니다.

![Langfuse Trace 뷰](/assets/images/posts/langfuse_trace.png)

### Langfuse v3 아키텍처

Langfuse v3는 대규모 트래픽을 처리하기 위해 이벤트 기반 비동기 아키텍처로 진화했습니다.

```
SDK/Integration
    │
    │ HTTP (비동기 ingestion)
    ▼
┌──────────────────┐
│  Langfuse Web    │ ← UI + API 서빙
│  (Application)   │
└────────┬─────────┘
         │ 이벤트 큐잉
         ▼
┌──────────────────┐     ┌──────────────────┐
│     Redis        │────▶│  Langfuse Worker │ ← 비동기 이벤트 처리
│  (Queue/Cache)   │     │  (Background)    │
└──────────────────┘     └────────┬─────────┘
                                  │ 저장
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
            ┌────────────┐ ┌──────────┐ ┌──────────┐
            │ PostgreSQL │ │ClickHouse│ │ S3/MinIO │
            │(트랜잭션)  │ │(분석쿼리)│ │(대용량)  │
            └────────────┘ └──────────┘ └──────────┘
```

주요 컴포넌트:

| 컴포넌트 | 역할 |
|---------|------|
| Langfuse Web | UI와 API를 서빙하는 메인 애플리케이션 |
| Langfuse Worker | 이벤트를 비동기로 처리하는 워커 |
| PostgreSQL | 사용자, 프로젝트 등 트랜잭션 데이터 |
| ClickHouse | Trace, Observation, Score 등 분석 데이터 (OLAP) |
| Redis/Valkey | 이벤트 큐잉과 캐싱 |
| S3/MinIO | 대용량 이벤트 원본, 멀티모달 데이터 저장 |

v2에서는 PostgreSQL 하나로 모든 것을 처리했지만, 수백만 건의 트레이싱 데이터가 쌓이면서 성능 병목이 발생했습니다. v3에서는 분석 쿼리를 ClickHouse로, 비동기 처리를 Redis + Worker로, 대용량 데이터를 S3로 분리하여 초당 수백 건의 이벤트를 안정적으로 처리할 수 있게 되었습니다.

![Langfuse Dashboard](/assets/images/posts/langfuse_dash_custom.png)

## LiteLLM — LLM Gateway

### LiteLLM이란?

LiteLLM은 100개 이상의 LLM API를 **OpenAI 호환 인터페이스**로 통합하는 오픈소스 AI Gateway(프록시 서버)입니다. OpenAI, Anthropic, Azure, Bedrock, vLLM, Ollama 등 어떤 모델이든 동일한 API 형식으로 호출할 수 있습니다.

```
애플리케이션
    │
    │ OpenAI 호환 API
    │ POST /v1/chat/completions
    ▼
┌──────────────────────────────────────┐
│          LiteLLM Proxy               │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 통합 인터페이스               │  │
│  │ - 모든 요청을 OpenAI 형식으로 │  │
│  │   수신하고 각 프로바이더      │  │
│  │   형식으로 변환               │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 부가 기능                     │  │
│  │ - 로드밸런싱 (같은 모델 복수  │  │
│  │   배포 간)                    │  │
│  │ - 비용 추적 (Virtual Key별)   │  │
│  │ - Rate Limiting / Budget      │  │
│  │ - Callback (Langfuse 등)      │  │
│  └────────────────────────────────┘  │
└──────┬──────────┬──────────┬─────────┘
       │          │          │
       ▼          ▼          ▼
   OpenAI     Anthropic   vLLM
   Azure      Bedrock     Ollama
   ...        ...         ...
```

### LiteLLM을 사용하는 이유

단순히 API를 통합하는 것 이상으로, 프로덕션 환경에서 LiteLLM이 해결하는 문제들이 있습니다.

**모델 라우팅과 로드밸런싱**: 같은 모델의 여러 배포(예: vLLM 인스턴스 3개)를 등록하고, LiteLLM이 자동으로 부하를 분산합니다. RPM/TPM 기반 제한도 가능합니다.

**Virtual Key 기반 접근 제어**: 팀이나 프로젝트별로 Virtual Key를 발급하여, 실제 LLM API 키를 노출하지 않으면서 비용과 사용량을 개별 추적할 수 있습니다.

**Callback을 통한 관찰성**: Langfuse를 callback으로 등록하면, LiteLLM을 거치는 모든 LLM 호출이 자동으로 Langfuse에 트레이싱됩니다. 애플리케이션 코드를 수정하지 않아도 됩니다.

### Langfuse + LiteLLM 조합의 아키텍처

두 도구를 함께 사용하면 다음과 같은 구조가 됩니다.

```
┌──────────────────────────────────────────────────────┐
│  AI Application (Langchain/Langgraph)                │
│                                                      │
│  @observe() 데코레이터로 트레이스 생성               │
│  → LiteLLM Proxy를 base_url로 설정                  │
└──────────────────────┬───────────────────────────────┘
                       │ OpenAI 호환 API
                       ▼
┌──────────────────────────────────────────────────────┐
│  LiteLLM Proxy                                       │
│                                                      │
│  callbacks: ["langfuse"]                             │
│  → 모든 LLM 호출을 Langfuse에 자동 전송             │
│  → 모델 라우팅, 로드밸런싱, 비용 추적                │
└──────────────────────┬───────────────────────────────┘
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           OpenAI   Anthropic  vLLM     ← 실제 LLM 프로바이더
              │        │        │
              └────────┼────────┘
                       │ 트레이싱 데이터
                       ▼
┌──────────────────────────────────────────────────────┐
│  Langfuse                                            │
│                                                      │
│  Trace → Observation(Generation) 구조로 시각화       │
│  프롬프트, 응답, 토큰, 비용, 지연 시간 기록           │
└──────────────────────────────────────────────────────┘
```

저희 프로젝트에서는 이 구조로 Langchain/Langgraph 기반 서비스의 모든 LLM 호출을 트레이싱했습니다. 특정 유저의 세션에서 input/output 품질을 확인하고, 토큰 소비량을 모니터링하면서 프롬프트를 튜닝하는 데 활용했습니다.

## Kubernetes 환경에 배포하기

로컬 WSL(AlmaLinux 9)에서 k3s 클러스터를 구성하여 테스트 환경을 만들고 있습니다. 실제 프로젝트에서도 Helm 기반으로 배포했으며, 아래는 그 과정을 정리한 것입니다.

### Langfuse Helm Chart 배포

Langfuse는 공식 Helm Chart를 제공합니다. 기본 설정으로 배포하면 PostgreSQL, ClickHouse, Redis, MinIO가 함께 배포됩니다.

```bash
# Helm 레포 추가
helm repo add langfuse https://langfuse.github.io/langfuse-k8s
helm repo update

# 네임스페이스 생성
kubectl create namespace langfuse
```

`values.yaml`을 작성합니다. 로컬 테스트 환경이므로 리소스를 최소화하고, 내장 데이터 스토어를 사용합니다.

```yaml
# langfuse-values.yaml
langfuse:
  # Langfuse Web/Worker 공통 설정
  salt:
    value: "your-random-salt-string-here"  # 랜덤 문자열
  nextauth:
    secret:
      value: "your-nextauth-secret-here"    # 랜덤 문자열
    url: "http://langfuse.local"            # Langfuse 접속 URL

  # Ingress 설정 (k3s Traefik 사용)
  ingress:
    enabled: true
    className: traefik
    hosts:
      - host: langfuse.local
        paths:
          - path: /
            pathType: Prefix

# 내장 PostgreSQL
postgresql:
  deploy: true
  auth:
    password: "langfuse-pg-password"

# 내장 ClickHouse
clickhouse:
  deploy: true
  shards: 1
  replicaCount: 1                    # 로컬에서는 1개로 충분
  auth:
    username: default
    password: "clickhouse-password"
  persistence:
    size: 10Gi                       # 로컬 테스트용

# 내장 Redis
redis:
  deploy: true
  architecture: standalone           # 로컬에서는 standalone

# 내장 MinIO (S3 호환 스토리지)
minio:
  deploy: true
```

```bash
# 배포
helm install langfuse langfuse/langfuse \
  -f langfuse-values.yaml \
  -n langfuse

# Pod 상태 확인
kubectl get pods -n langfuse
```

정상적으로 배포되면 다음과 같은 Pod들이 실행됩니다.

```
NAME                               READY   STATUS    RESTARTS
langfuse-web-xxxxx                 1/1     Running   0
langfuse-worker-xxxxx              1/1     Running   0
langfuse-postgresql-0              1/1     Running   0
langfuse-clickhouse-shard0-0       1/1     Running   0
langfuse-redis-master-0            1/1     Running   0
langfuse-minio-xxxxx               1/1     Running   0
```

`/etc/hosts`에 `langfuse.local`을 추가하고 브라우저에서 접속하면 Langfuse UI를 볼 수 있습니다. 초기 설정에서 프로젝트를 생성하고, **Settings → API Keys**에서 Public Key와 Secret Key를 발급받습니다. 이 키가 LiteLLM과 SDK 연동에 필요합니다.

### LiteLLM Proxy 배포

LiteLLM은 Deployment + ConfigMap으로 배포합니다.

```yaml
# litellm-config.yaml (ConfigMap으로 마운트할 설정)
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: langfuse
data:
  config.yaml: |
    model_list:
      - model_name: gpt-4o
        litellm_params:
          model: openai/gpt-4o
          api_key: os.environ/OPENAI_API_KEY
      - model_name: claude-sonnet
        litellm_params:
          model: anthropic/claude-sonnet-4-20250514
          api_key: os.environ/ANTHROPIC_API_KEY
      # vLLM 로컬 모델 예시
      - model_name: local-llm
        litellm_params:
          model: openai/my-model
          api_base: http://vllm-service:8000/v1
          api_key: "no-key"

    litellm_settings:
      callbacks: ["langfuse"]   # Langfuse 연동

    general_settings:
      master_key: os.environ/LITELLM_MASTER_KEY
```

```yaml
# litellm-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm
  namespace: langfuse
spec:
  replicas: 1
  selector:
    matchLabels:
      app: litellm
  template:
    metadata:
      labels:
        app: litellm
    spec:
      containers:
      - name: litellm
        image: ghcr.io/berriai/litellm:main-latest
        ports:
        - containerPort: 4000
        env:
        - name: LITELLM_MASTER_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-secrets
              key: master-key
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-secrets
              key: openai-api-key
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-secrets
              key: anthropic-api-key
        # Langfuse 연동 환경변수
        - name: LANGFUSE_PUBLIC_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-secrets
              key: langfuse-public-key
        - name: LANGFUSE_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-secrets
              key: langfuse-secret-key
        - name: LANGFUSE_HOST
          value: "http://langfuse-web.langfuse.svc.cluster.local:3000"
        volumeMounts:
        - name: config
          mountPath: /app/config.yaml
          subPath: config.yaml
        args: ["--config", "/app/config.yaml", "--port", "4000"]
      volumes:
      - name: config
        configMap:
          name: litellm-config
---
apiVersion: v1
kind: Service
metadata:
  name: litellm
  namespace: langfuse
spec:
  selector:
    app: litellm
  ports:
  - port: 4000
    targetPort: 4000
```

```bash
# Secret 생성 (실제 값으로 대체)
kubectl create secret generic litellm-secrets -n langfuse \
  --from-literal=master-key="sk-litellm-master-key" \
  --from-literal=openai-api-key="sk-..." \
  --from-literal=anthropic-api-key="sk-ant-..." \
  --from-literal=langfuse-public-key="pk-lf-..." \
  --from-literal=langfuse-secret-key="sk-lf-..."

# 배포
kubectl apply -f litellm-config.yaml
kubectl apply -f litellm-deployment.yaml
```

배포 후 LiteLLM Proxy가 정상 동작하는지 확인합니다.

```bash
# 포트 포워딩
kubectl port-forward svc/litellm 4000:4000 -n langfuse

# 테스트 요청
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-litellm-master-key" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

응답이 정상적으로 오면, Langfuse UI에서 Traces 탭을 확인합니다. `callbacks: ["langfuse"]` 설정으로 LiteLLM을 거치는 모든 요청이 자동으로 Langfuse에 트레이싱되어 있어야 합니다.

## SDK를 활용한 트레이싱

LiteLLM Proxy의 callback만으로도 LLM 호출은 자동 트레이싱되지만, 애플리케이션 레벨의 더 세밀한 트레이싱이 필요한 경우 Langfuse SDK를 직접 사용합니다.

### Python SDK — @observe 데코레이터

Langfuse Python SDK의 `@observe()` 데코레이터를 사용하면 함수 단위의 트레이싱이 가능합니다.

```bash
pip install langfuse openai
```

```python
import os
from langfuse.decorators import observe, langfuse_context
from openai import OpenAI

# 환경변수 설정
os.environ["LANGFUSE_PUBLIC_KEY"] = "pk-lf-..."
os.environ["LANGFUSE_SECRET_KEY"] = "sk-lf-..."
os.environ["LANGFUSE_HOST"] = "http://langfuse.local"  # Self-hosted URL

# LiteLLM Proxy를 base_url로 사용
client = OpenAI(
    api_key="sk-litellm-master-key",
    base_url="http://localhost:4000/v1"  # LiteLLM Proxy
)

@observe()
def retrieve_context(query: str) -> str:
    """RAG 검색 단계 — Span으로 기록"""
    # 실제로는 벡터 DB 검색
    return f"관련 문서: {query}에 대한 컨텍스트"

@observe()
def generate_answer(query: str, context: str) -> str:
    """LLM 호출 단계 — Generation으로 기록"""
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": f"다음 컨텍스트를 기반으로 답변하세요: {context}"},
            {"role": "user", "content": query}
        ]
    )
    return response.choices[0].message.content

@observe()
def rag_pipeline(query: str) -> str:
    """전체 RAG 파이프라인 — 최상위 Trace"""
    context = retrieve_context(query)
    answer = generate_answer(query, context)
    return answer

# 실행
result = rag_pipeline("Kubernetes에서 Pod 네트워킹은 어떻게 동작하나요?")
print(result)
```

`@observe()` 데코레이터가 붙은 함수는 자동으로 Langfuse Trace/Span으로 기록됩니다. 중첩된 함수 호출은 부모-자식 관계로 연결되어, Langfuse UI에서 다음과 같은 계층 구조로 보입니다.

```
Trace: rag_pipeline
├── Span: retrieve_context (23ms)
└── Generation: generate_answer (1,247ms)
    ├── Model: gpt-4o
    ├── Input tokens: 156
    ├── Output tokens: 342
    ├── Cost: $0.0089
    └── Latency: 1,247ms
```

### 분산 트레이싱: 서비스 간 Trace 연결 (Propagation)

마이크로서비스 환경에서 여러 서비스를 거치는 요청의 전체 흐름을 추적하려면 **Trace Context Propagation**이 필요합니다. Langfuse SDK는 W3C Trace Context 표준을 지원하여, 서비스 간 호출에서도 동일한 `trace_id`로 연결된 트레이스를 생성할 수 있습니다.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Service A (Frontend API)                                           │
│                                                                     │
│  @observe() ──┬── trace_id: abc-123 생성                            │
│               │                                                     │
│               │ HTTP 요청 (traceparent 헤더 포함)                    │
│               │ traceparent: 00-abc123-def456-01                    │
│               ▼                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Service B (RAG Service)                                      │  │
│  │                                                               │  │
│  │  @observe() ── traceparent 헤더에서 trace_id 추출             │  │
│  │            ── 동일한 trace_id로 span 생성                     │  │
│  │                                                               │  │
│  │                    ▼ HTTP 요청                                │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  Service C (LLM Gateway)                                │  │  │
│  │  │                                                         │  │  │
│  │  │  @observe() ── 동일한 trace_id로 generation 기록        │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

Langfuse UI에서 단일 Trace로 시각화:
  Trace: abc-123
  ├── Span: Service A - handle_request (전체 2,450ms)
  │   └── Span: Service B - rag_search (1,890ms)
  │       ├── Span: vector_search (120ms)
  │       └── Generation: Service C - llm_call (1,650ms)
```

**서비스 A (요청 시작)**:

```python
from langfuse.decorators import observe, langfuse_context
import httpx

@observe()
def handle_user_request(query: str) -> str:
    """사용자 요청을 처리하고 RAG 서비스를 호출"""

    # 현재 trace context를 HTTP 헤더로 전파
    trace_id = langfuse_context.get_current_trace_id()
    observation_id = langfuse_context.get_current_observation_id()

    headers = {
        "X-Langfuse-Trace-Id": trace_id,
        "X-Langfuse-Parent-Observation-Id": observation_id,
    }

    # 다른 서비스 호출
    response = httpx.post(
        "http://rag-service/search",
        json={"query": query},
        headers=headers
    )
    return response.json()["answer"]
```

**서비스 B (요청 수신 및 전파)**:

```python
from langfuse.decorators import observe, langfuse_context
from flask import Flask, request

app = Flask(__name__)

@app.route("/search", methods=["POST"])
def search():
    # 상위 서비스에서 전파된 trace context 추출
    trace_id = request.headers.get("X-Langfuse-Trace-Id")
    parent_observation_id = request.headers.get("X-Langfuse-Parent-Observation-Id")

    # trace context를 설정하여 동일한 trace에 연결
    with langfuse_context.configure(
        trace_id=trace_id,
        parent_observation_id=parent_observation_id
    ):
        result = process_query(request.json["query"])

    return {"answer": result}

@observe()
def process_query(query: str) -> str:
    """RAG 처리 및 LLM 호출"""
    context = retrieve_documents(query)
    return generate_response(query, context)
```

**OpenTelemetry 표준 활용**:

Langfuse는 OpenTelemetry와도 통합됩니다. 기존 OTEL 인프라가 있다면 W3C Trace Context (`traceparent` 헤더)를 활용할 수 있습니다.

```python
from opentelemetry import trace
from opentelemetry.propagate import inject, extract

# 발신 측: trace context를 헤더에 주입
headers = {}
inject(headers)  # traceparent, tracestate 헤더 추가
response = httpx.post(url, headers=headers)

# 수신 측: 헤더에서 trace context 추출
context = extract(request.headers)
with trace.get_tracer(__name__).start_as_current_span("process", context=context):
    process_request()
```

이 구조를 사용하면 API Gateway → Backend → RAG Service → LLM Gateway로 이어지는 전체 요청 흐름이 Langfuse에서 하나의 연결된 Trace로 시각화됩니다. 어느 서비스에서 지연이 발생했는지, LLM 호출이 전체 응답 시간에서 차지하는 비중이 얼마인지를 한눈에 파악할 수 있습니다.

### Langchain/Langgraph 연동

Langchain을 사용한다면 callback handler로 더 간단하게 연동할 수 있습니다.

```python
from langfuse.callback import CallbackHandler
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate

# Langfuse callback handler
langfuse_handler = CallbackHandler(
    public_key="pk-lf-...",
    secret_key="sk-lf-...",
    host="http://langfuse.local"
)

# LiteLLM Proxy를 통한 LLM 호출
llm = ChatOpenAI(
    model="gpt-4o",
    openai_api_key="sk-litellm-master-key",
    openai_api_base="http://localhost:4000/v1"
)

prompt = ChatPromptTemplate.from_template(
    "다음 주제에 대해 간결하게 설명해주세요: {topic}"
)

chain = prompt | llm

# 실행 시 callback handler 전달
response = chain.invoke(
    {"topic": "Kubernetes Service 로드밸런싱"},
    config={"callbacks": [langfuse_handler]}
)
```

Langchain이 체인 실행 중 발생하는 모든 이벤트(LLM 호출, 도구 사용, 체인 단계 등)를 callback handler를 통해 Langfuse에 전달합니다. Langgraph의 AgentGraph도 동일한 방식으로, 각 노드의 실행이 Observation으로 기록되어 그래프 전체의 실행 흐름을 시각화할 수 있습니다.

### 메타데이터 활용

트레이스에 메타데이터를 추가하면 이후 분석과 필터링이 훨씬 편해집니다.

```python
from langfuse.decorators import observe, langfuse_context

@observe()
def process_request(user_id: str, session_id: str, query: str) -> str:
    # 트레이스에 메타데이터 추가
    langfuse_context.update_current_trace(
        user_id=user_id,
        session_id=session_id,
        tags=["production", "chatbot", "v2"],
        metadata={
            "environment": "production",
            "version": "2.1.0"
        }
    )

    return generate_response(query)
```

Langfuse UI에서 user_id별 비용 분석, session_id별 대화 흐름 추적, tag별 성능 비교 등이 가능합니다. 프로젝트에서는 이 메타데이터를 활용하여 특정 유저 세션의 전체 대화를 추적하고, input/output 품질을 확인하면서 프롬프트를 튜닝했습니다.

## Grafana Tempo 연동 — 기존 모니터링 스택에 LLM 트레이싱 통합

Langfuse의 트레이싱만으로도 LLM 레벨의 관찰성은 충분하지만, 실제 운영 환경에서는 "LLM 호출 지연이 발생했는데, 그게 네트워크 문제인지 모델 문제인지 인프라 문제인지"를 파악해야 합니다. 이를 위해 LLM 트레이스를 기존 분산 트레이싱 시스템(Grafana Tempo)에 통합합니다.

기존 프로젝트에서는 Jaeger를 사용했지만, 여기서는 Grafana 스택의 Tempo를 기준으로 설명합니다. 원리는 동일합니다. 핵심은 OpenTelemetry입니다.

### 전체 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Application                                                 │
│  (Langchain + @observe + OpenTelemetry SDK)                    │
│                                                                 │
│  → Langfuse 트레이스 생성                                       │
│  → OpenTelemetry Span 생성 (동일 trace_id)                      │
└──────────────┬──────────────────────┬───────────────────────────┘
               │                      │
               │ OTLP                 │ Langfuse SDK
               ▼                      ▼
┌──────────────────────┐  ┌──────────────────────────────────┐
│  OpenTelemetry       │  │  Langfuse                        │
│  Collector           │  │  (LLM 트레이싱 UI)               │
│                      │  │                                  │
│  receivers:          │  │  Trace → Generation 시각화       │
│    otlp (gRPC/HTTP)  │  │  프롬프트, 토큰, 비용 분석       │
│                      │  │                                  │
│  exporters:          │  └──────────────────────────────────┘
│    otlp → Tempo      │
│    otlphttp → Langfuse (선택)
└──────────┬───────────┘
           │ OTLP
           ▼
┌──────────────────────┐     ┌──────────────────────────┐
│  Grafana Tempo       │────▶│  Grafana                 │
│  (트레이스 스토리지)  │     │  (통합 대시보드)          │
│                      │     │                          │
│  전체 서비스 트레이스 │     │  Tempo: 분산 트레이싱     │
│  LLM 호출 포함       │     │  Prometheus: 메트릭       │
│                      │     │  Loki: 로그               │
└──────────────────────┘     └──────────────────────────┘
```

### OpenTelemetry Collector 배포

OpenTelemetry Collector가 애플리케이션의 트레이스를 수집하여 Tempo와 Langfuse 양쪽으로 보내는 역할을 합니다.

```yaml
# otel-collector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch:
        timeout: 5s
        send_batch_size: 1024

    exporters:
      # Grafana Tempo로 전송
      otlp/tempo:
        endpoint: tempo.monitoring.svc.cluster.local:4317
        tls:
          insecure: true

      # Langfuse OTEL endpoint로 전송 (선택)
      otlphttp/langfuse:
        endpoint: "http://langfuse-web.langfuse.svc.cluster.local:3000/api/public/otel"
        headers:
          Authorization: "Basic <base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)>"

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [otlp/tempo, otlphttp/langfuse]
```

### Grafana Tempo 배포

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install tempo grafana/tempo \
  -n monitoring \
  --create-namespace \
  -f tempo-values.yaml
```

```yaml
# tempo-values.yaml (간소화된 로컬 설정)
tempo:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
  storage:
    trace:
      backend: local
      local:
        path: /var/tempo/traces
  retention:
    trace: 72h

persistence:
  enabled: true
  size: 10Gi
```

### Grafana에서 Tempo 데이터소스 추가

Grafana에서 Tempo를 데이터소스로 추가하면, 전체 서비스 트레이싱과 LLM 트레이싱을 하나의 대시보드에서 볼 수 있습니다.

```yaml
# Grafana 데이터소스 설정 (provisioning)
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo.monitoring.svc.cluster.local:3100
    jsonData:
      tracesToLogs:
        datasourceUid: loki
      serviceMap:
        datasourceUid: prometheus
```

Grafana의 Explore 뷰에서 TraceQL로 LLM 관련 트레이스를 조회할 수 있습니다.

```
# LLM Generation 트레이스만 조회
{ span.gen_ai.system = "openai" }

# 특정 모델의 느린 호출
{ span.gen_ai.request.model = "gpt-4o" && duration > 3s }

# 특정 사용자의 트레이스
{ resource.langfuse.user.id = "user-123" }
```

### 통합 효과

이 구성이 완성되면 다음과 같은 흐름으로 문제를 추적할 수 있습니다.

```
Grafana 대시보드: "API 응답 시간 급증 감지"
    │
    │ Tempo에서 해당 시간대 트레이스 조회
    ▼
Tempo 트레이스:
  user-request (총 4,200ms)
  ├── api-gateway (12ms)
  ├── auth-service (45ms)
  ├── rag-pipeline (4,100ms)                ← 병목 발견
  │   ├── vector-search (120ms)
  │   └── llm-generation (3,950ms)          ← LLM 호출이 원인
  │       ├── model: gpt-4o
  │       └── tokens: 2,847
  └── response-format (43ms)
    │
    │ trace_id로 Langfuse에서 상세 확인
    ▼
Langfuse 트레이스:
  llm-generation 상세:
  ├── Input: [system prompt + context + query]
  ├── Output: [응답 전문]
  ├── Token usage: prompt=1,203 / completion=1,644
  ├── Cost: $0.047
  └── Latency breakdown: TTFT=890ms, total=3,950ms
```

Grafana에서 인프라 레벨의 병목을 찾고, Langfuse에서 LLM 레벨의 상세 정보를 확인합니다. 동일한 `trace_id`를 공유하므로 Grafana에서 Langfuse로, Langfuse에서 Grafana로 자연스럽게 이동할 수 있습니다. 기존 프로젝트에서는 Jaeger + Grafana 조합으로 이와 동일한 구조를 구성하여 인프라 트레이싱과 LLM 트레이싱을 하나의 Grafana 대시보드에서 통합하여 확인했습니다.

![Grafana Tempo 트레이스](/assets/images/posts/grafana_trace.png)

## Langfuse에서 확인할 수 있는 것들

배포와 연동이 완료된 후, Langfuse UI에서 실제로 활용하는 주요 기능들입니다.

### Traces 뷰

모든 트레이스 목록과 각 트레이스의 상세 타임라인을 볼 수 있습니다. 필터로 user, session, tag, 시간 범위 등을 지정하여 특정 조건의 트레이스만 조회 가능합니다. 각 Generation의 실제 프롬프트와 응답 전문, 토큰 수, 비용, 지연 시간을 확인할 수 있습니다.

### Sessions 뷰

멀티턴 대화를 세션 단위로 묶어서 볼 수 있습니다. 사용자의 전체 대화 흐름을 시간순으로 따라가며, 프롬프트가 대화가 진행됨에 따라 어떻게 변형되는지 추적할 수 있습니다.

### Dashboard

프로젝트 전체의 메트릭을 대시보드로 제공합니다. 비용(모델별, 사용자별), 지연 시간(P50, P90, P99), 호출 횟수를 시계열로 확인할 수 있습니다. 프롬프트 버전이나 모델을 변경한 시점 전후의 메트릭 비교가 가능합니다.

### 비용 추적

LiteLLM과 연동하면 모델별 토큰 단가가 자동 적용되어, 요청당 비용이 자동 계산됩니다. 사용자별, 세션별, 기능별 비용 분석이 가능합니다.

## 정리

| 구성 요소 | 역할 | 비고 |
|---------|------|------|
| **Langfuse** | LLM 트레이싱, 프롬프트 관리, 평가 | 오픈소스, Helm으로 배포 |
| **LiteLLM** | LLM Gateway, 모델 통합 인터페이스 | callback으로 Langfuse 자동 연동 |
| **OpenTelemetry** | 트레이스 수집/전파 표준 | Langfuse v3가 OTEL 기반 |
| **Grafana Tempo** | 분산 트레이싱 스토리지 | 기존 모니터링 스택에 통합 |

Langfuse와 LiteLLM 조합은 "LLM 호출을 트레이싱하고 싶다"는 가장 기본적인 니즈부터, "프로덕션 환경에서 프롬프트 버전 관리와 품질 평가까지 하고 싶다"는 고급 니즈까지 커버합니다. 특히 서비스 간 **Trace Context Propagation**을 활용하면, 마이크로서비스 환경에서도 전체 요청 흐름을 하나의 연결된 트레이스로 추적할 수 있습니다.

이 글에서 다룬 것은 Langfuse의 Observability 기능을 1차원적으로 사용한 것에 불과합니다. Prompt Management로 코드 변경 없이 프롬프트를 배포하고, LLM-as-a-Judge로 프로덕션 트레이스의 품질을 자동 평가하며, Dataset과 Experiment로 체계적인 오프라인 테스트를 수행하는 등 활용할 수 있는 기능이 훨씬 많습니다. 이 부분은 다음 글에서 다뤄보겠습니다.

## References

- [Langfuse Documentation](https://langfuse.com/docs)
- [Langfuse Python SDK - Decorators](https://langfuse.com/docs/sdk/python/decorators)
- [LiteLLM Documentation](https://docs.litellm.ai/)
- [LiteLLM + Langfuse Integration](https://docs.litellm.ai/docs/observability/langfuse_integration)
- [OpenTelemetry - Context Propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [Grafana Tempo](https://grafana.com/docs/tempo/latest/)
