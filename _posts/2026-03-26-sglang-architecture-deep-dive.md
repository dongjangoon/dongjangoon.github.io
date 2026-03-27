---
layout: single
title: "SGLang 아키텍처 Deep Dive - 논문부터 내부 구조까지 (SGLang 시리즈 Part 1)"
date: 2026-03-26 10:00:00 +0900
categories: mlops
tags: [sglang, llm-serving, gpu, inference, radix-attention, overlap-scheduling, vllm, serving-engine]
excerpt: "SGLang은 단순한 서빙 엔진이 아닙니다. 구조화된 LLM 프로그램을 효율적으로 실행하기 위한 시스템으로, RadixAttention과 Overlap Scheduling이라는 두 가지 핵심 혁신을 통해 vLLM 대비 최대 6.4배 높은 처리량을 달성합니다. 이 글에서는 NeurIPS 2024 논문을 기반으로 SGLang의 설계 철학과 전체 아키텍처를 깊이 있게 분석합니다."
---

## 들어가며

> 이 글은 **SGLang v0.5.9** (2026년 2월)과 **vLLM v0.17.1** (2026년 3월) 기준으로 작성되었습니다.

[이전 글]({{ site.baseurl }}{% post_url 2026-02-08-vllm-async-scheduling %})에서 vLLM V1의 내부 구조를 살펴봤습니다. CPU 스케줄링과 GPU Forward Pass의 분리, Async Scheduling의 파이프라인 구조까지. vLLM은 **단일 요청을 효율적으로 서빙**하는 데 최적화된 엔진입니다.

하지만 실제 LLM 서비스는 단일 요청으로 끝나지 않습니다.

```python
# 실제 LLM 애플리케이션의 호출 패턴
system_prompt = "당신은 금융 분석 전문가입니다..."

# 같은 system prompt로 수백 건의 요청이 들어옴
response_1 = llm(system_prompt + user_query_1)  # KV cache 계산
response_2 = llm(system_prompt + user_query_2)  # 동일한 KV cache 또 계산
response_3 = llm(system_prompt + user_query_3)  # 또 계산...

# Multi-turn 대화
turn_1 = llm(system + user_1)
turn_2 = llm(system + user_1 + turn_1 + user_2)  # 이전 턴의 KV cache 재활용 가능?
```

동일한 system prompt에 대한 KV cache를 매번 다시 계산하고, multi-turn 대화에서 이전 턴의 KV cache를 재활용하지 못한다면 엄청난 GPU 연산 낭비가 발생합니다. 여기에 JSON 스키마 같은 구조화된 출력까지 요구되면, 문제는 더 복잡해집니다.

SGLang은 이 문제를 정면으로 해결합니다. NeurIPS 2024에서 발표된 논문 *"SGLang: Efficient Execution of Structured Language Model Programs"* 는 **LLM 프로그램의 실행 효율성**이라는 새로운 관점에서 서빙 엔진을 재설계했습니다.

이 글에서는 논문의 핵심 아이디어부터 실제 구현의 아키텍처까지 하나씩 파고들어 보겠습니다.

## 논문이 정의하는 문제: LLM 프로그램

### 단일 호출을 넘어서

SGLang 논문의 핵심 통찰은 명확합니다. **현대의 LLM 애플리케이션은 단일 API 호출이 아니라 여러 호출이 엮인 "프로그램"이다.**

논문에서는 이를 다섯 가지 대표적인 패턴으로 분류합니다.

| 패턴 | 설명 | 예시 |
|------|------|------|
| **Multi-turn Chat** | 이전 대화 맥락을 누적하며 반복 호출 | 챗봇, 고객 상담 |
| **Few-shot Learning** | 동일한 예시를 공유하는 다수의 요청 | 분류, 추출 태스크 |
| **RAG** | 검색된 문서 + 공통 프롬프트 | 사내 문서 QA |
| **Agent / Tool Use** | LLM 출력으로 다음 호출을 결정 | ReAct, Function Calling |
| **Constrained Decoding** | JSON 스키마 등 구조적 제약 하에 생성 | API 응답, 데이터 추출 |

이 패턴들은 공통된 특성을 가집니다. **요청 간에 prefix를 공유**하거나, **출력 형식이 구조적으로 제약**되거나, **이전 출력이 다음 입력에 포함**됩니다.

### 기존 서빙 엔진의 한계

vLLM의 PagedAttention은 **단일 요청 내부**의 메모리 효율을 극적으로 개선했습니다. 하지만 **요청 간** KV cache 재활용은 설계의 주요 목표가 아니었습니다.

```
요청 A: [System Prompt] + [User Query A]  → KV cache 전체 계산
요청 B: [System Prompt] + [User Query B]  → 동일한 System Prompt의 KV cache 또 계산
요청 C: [System Prompt] + [User Query C]  → 또 계산

→ System Prompt가 2048 토큰이면, 3번의 요청에서 6144 토큰분의 prefill이 중복 실행됨
```

vLLM은 이후 APC(Automatic Prefix Caching)를 hash 기반으로 추가했지만, SGLang은 처음부터 이 문제를 아키텍처의 중심에 놓고 설계했다는 점에서 접근이 근본적으로 다릅니다.

## SGLang의 두 가지 핵심 혁신

논문은 SGLang의 기여를 크게 두 축으로 제시합니다.

```
SGLang System
├── Frontend: SGLang Language (Python DSL)
│   ├── gen(), select(), fork(), join() 프리미티브
│   └── Interpreter가 실행 그래프를 런타임에 최적화
│
└── Backend: SGLang Runtime
    ├── RadixAttention: KV cache를 Radix Tree로 관리하여 prefix 자동 재활용
    ├── Compressed FSM: 구조화된 출력을 위한 압축 유한 상태 머신
    └── Overlap Scheduling: CPU/GPU 파이프라이닝으로 유휴 시간 제거
```

이 글에서는 Backend Runtime의 아키텍처를 중심으로 분석합니다. Compressed FSM은 시리즈 Part 3에서 별도로 다룹니다.

## Frontend: SGLang Language

아키텍처를 이해하기 전에, SGLang이 제공하는 Frontend DSL을 먼저 살펴보겠습니다. 이 DSL이 왜 존재하는지를 이해하면 Backend 설계의 동기가 명확해집니다.

### 프리미티브 설계

SGLang은 `@sgl.function` 데코레이터로 LLM 프로그램을 정의합니다. 핵심 프리미티브는 다섯 가지입니다.

```python
import sglang as sgl

@sgl.function
def financial_analysis(s, company_name, financial_data):
    # extend: 프롬프트에 텍스트 추가
    s += sgl.system("당신은 금융 분석 전문가입니다.")
    s += sgl.user(f"{company_name}의 재무 데이터를 분석해주세요.\n{financial_data}")

    # gen: 텍스트 생성 (변수에 저장)
    s += sgl.assistant(sgl.gen("analysis", max_tokens=512))

    # select: 선택지 중 가장 높은 확률의 옵션 선택
    s += sgl.user("이 종목의 투자 등급을 매겨주세요.")
    s += sgl.assistant(sgl.select("rating", ["매수", "보유", "매도"]))

    # gen with regex: 구조화된 출력
    s += sgl.user("목표가를 숫자로만 알려주세요.")
    s += sgl.assistant(sgl.gen("target_price", regex=r"\d{1,7}"))
```

각 프리미티브의 역할을 정리하면 다음과 같습니다.

| 프리미티브 | 역할 | Backend 연동 |
|-----------|------|-------------|
| `extend` (`+=`) | 프롬프트에 텍스트 추가 | Prefill 요청 생성 |
| `gen(var, ...)` | 텍스트 생성, 결과를 변수에 저장 | Decode 요청 + 샘플링 |
| `select(var, choices)` | 선택지 중 확률이 가장 높은 것 선택 | 각 선택지별 likelihood 계산 |
| `fork(n)` | 현재 상태를 n개로 복제 | KV cache 참조 복사 (copy-on-write) |
| `join()` | fork된 상태들을 합침 | 결과 동기화 |

### fork/join이 만드는 병렬 실행

`fork`와 `join`은 단순한 문법이 아닙니다. Backend에서 KV cache의 copy-on-write 공유를 일으킵니다.

```python
@sgl.function
def multi_perspective_analysis(s, query):
    s += sgl.system("당신은 투자 분석가입니다.")
    s += sgl.user(query)

    # fork: 동일한 KV cache를 공유하는 3개의 병렬 브랜치 생성
    perspectives = s.fork(3)

    perspectives[0] += sgl.user("기술적 분석 관점에서 답변해주세요.")
    perspectives[0] += sgl.assistant(sgl.gen("technical", max_tokens=256))

    perspectives[1] += sgl.user("펀더멘털 관점에서 답변해주세요.")
    perspectives[1] += sgl.assistant(sgl.gen("fundamental", max_tokens=256))

    perspectives[2] += sgl.user("리스크 관점에서 답변해주세요.")
    perspectives[2] += sgl.assistant(sgl.gen("risk", max_tokens=256))

    # join: 3개의 결과를 동기화
    s += sgl.join(perspectives)
```

이 코드에서 `fork` 시점까지의 KV cache는 3개 브랜치가 **물리적으로 동일한 메모리를 참조**합니다. 이것이 가능한 이유는 Backend의 RadixAttention이 tree 구조로 KV cache를 관리하기 때문입니다.

### OpenAI-Compatible API

DSL 없이도 SGLang은 OpenAI 호환 API 서버로 사용할 수 있습니다. 실제 프로덕션에서는 이 방식이 더 일반적입니다.

```bash
# SGLang 서버 실행
python -m sglang.launch_server \
    --model-path meta-llama/Llama-3.1-70B-Instruct \
    --tp 4 \
    --port 30000
```

```python
# OpenAI SDK로 호출 (drop-in replacement)
from openai import OpenAI
client = OpenAI(base_url="http://localhost:30000/v1", api_key="EMPTY")

response = client.chat.completions.create(
    model="meta-llama/Llama-3.1-70B-Instruct",
    messages=[{"role": "user", "content": "삼성전자 분석해줘"}],
    response_format={"type": "json_object"}  # 구조화된 출력
)
```

이 경우에도 Backend의 RadixAttention, Overlap Scheduling 등 모든 최적화는 동일하게 적용됩니다.

## Backend 아키텍처: 전체 구조

이제 SGLang Runtime의 내부 아키텍처를 살펴보겠습니다.

### 멀티 프로세스 구조

SGLang의 Backend는 vLLM V1과 유사하게 **역할별로 프로세스를 분리**합니다. 하지만 컴포넌트의 구성과 데이터 흐름에서 차이가 있습니다.

```
┌──────────────────────────────────────────────────────┐
│  프로세스 1: API Server + TokenizerManager            │
│                                                      │
│  ┌────────────────┐  ┌──────────────────┐            │
│  │ FastAPI Server │  │ TokenizerManager │            │
│  │ (HTTP 엔드포인트)│  │ ├─ Tokenize     │            │
│  │                │  │ ├─ Chat Template │            │
│  │ /v1/chat/...   │  │ └─ 멀티모달 입력  │            │
│  └───────┬────────┘  └────────┬─────────┘            │
│          │                    │                      │
│          └────────┬───────────┘                      │
│                   │ ZeroMQ                           │
└───────────────────┼──────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────┐
│  프로세스 2: Scheduler                                │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  Scheduler (핵심 오케스트레이터)              │      │
│  │  ├─ waiting_queue (새 요청 대기열)           │      │
│  │  ├─ running_batch (실행 중인 배치)           │      │
│  │  ├─ RadixCache (KV cache 관리)             │      │
│  │  │   └─ Radix Tree 구조                    │      │
│  │  ├─ GrammarBackend (구조화 출력)            │      │
│  │  │   └─ XGrammar / LLGuidance              │      │
│  │  └─ OverlapThread (CPU/GPU 오버랩)         │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  TpModelWorkerClient                       │      │
│  │  └─ GPU Worker와의 통신 관리                │      │
│  └────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────┐
│  프로세스 3~N: GPU Workers                            │
│                                                      │
│  Worker 0 (GPU 0)     Worker 1 (GPU 1)     ...       │
│  ┌───────────────┐   ┌───────────────┐              │
│  │ ModelRunner    │   │ ModelRunner    │              │
│  │ ├─ Model      │   │ ├─ Model      │              │
│  │ │ (nn.Module) │   │ │ (nn.Module) │              │
│  │ ├─ FlashInfer │   │ ├─ FlashInfer │              │
│  │ │  Attention  │   │ │  Attention  │              │
│  │ └─ CUDA Graphs│   │ └─ CUDA Graphs│              │
│  └───────────────┘   └───────────────┘              │
└──────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────┐
│  프로세스 N+1: DetokenizerManager                     │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  Incremental Detokenization                │      │
│  │  └─ 토큰 → 텍스트 변환 (스트리밍 출력)      │      │
│  └────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
```

### vLLM V1과의 구조적 비교

두 엔진의 아키텍처를 나란히 놓고 보면 설계 철학의 차이가 드러납니다.

| 컴포넌트 | vLLM V1 | SGLang |
|---------|---------|--------|
| **API Server** | FastAPI | FastAPI |
| **IPC** | ZeroMQ | ZeroMQ |
| **스케줄러** | EngineCore 프로세스 내 Scheduler | 별도 Scheduler 프로세스 |
| **KV Cache** | PagedAttention (hash table, 고정 블록) | RadixAttention (radix tree, 가변 노드) |
| **Prefix Caching** | APC (후에 추가, hash 기반) | RadixCache (설계 초기부터 내장, tree 기반) |
| **구조화 출력** | XGrammar (외부 통합) | Compressed FSM (자체 설계) + XGrammar |
| **CPU/GPU 오버랩** | Async Scheduling | Overlap Scheduling |
| **Attention Backend** | FlashAttention / FlashInfer | FlashInfer (기본값) |
| **Detokenizer** | AsyncLLM 프로세스 내 포함 | 별도 DetokenizerManager 프로세스 |

가장 큰 구조적 차이는 **KV cache 관리**와 **prefix caching의 위상**입니다. vLLM에서 APC는 선택적 기능이지만, SGLang에서 RadixCache는 스케줄러의 핵심 의사결정 기준입니다.

## 요청 처리 흐름: 처음부터 끝까지

하나의 요청이 SGLang을 통과하는 전체 과정을 추적해 보겠습니다.

```
Client                 TokenizerManager          Scheduler              ModelRunner          DetokenizerManager
  │                         │                       │                      │                       │
  │  HTTP POST /v1/chat     │                       │                      │                       │
  │────────────────────────>│                       │                      │                       │
  │                         │                       │                      │                       │
  │                         │  1) Tokenize          │                      │                       │
  │                         │  2) Chat Template     │                      │                       │
  │                         │                       │                      │                       │
  │                         │  ZMQ: TokenizedReq    │                      │                       │
  │                         │──────────────────────>│                      │                       │
  │                         │                       │                      │                       │
  │                         │                       │  3) RadixCache       │                       │
  │                         │                       │     Prefix Match     │                       │
  │                         │                       │     → cached 토큰 발견│                       │
  │                         │                       │                      │                       │
  │                         │                       │  4) waiting_queue에  │                       │
  │                         │                       │     삽입 (cache hit   │                       │
  │                         │                       │     rate 기준 정렬)   │                       │
  │                         │                       │                      │                       │
  │                         │                       │  5) 배치 구성         │                       │
  │                         │                       │     - Decode 우선     │                       │
  │                         │                       │     - Prefill: cache  │                       │
  │                         │                       │       hit rate 순     │                       │
  │                         │                       │                      │                       │
  │                         │                       │  ForwardBatch        │                       │
  │                         │                       │─────────────────────>│                       │
  │                         │                       │                      │                       │
  │                         │                       │                      │  6) Forward Pass      │
  │                         │                       │                      │     (Prefill/Decode)  │
  │                         │                       │                      │                       │
  │                         │                       │     Output tokens    │                       │
  │                         │                       │<─────────────────────│                       │
  │                         │                       │                      │                       │
  │                         │                       │  7) RadixCache       │                       │
  │                         │                       │     에 새 KV 삽입     │                       │
  │                         │                       │                      │                       │
  │                         │                       │  Output tokens       │                       │
  │                         │                       │─────────────────────────────────────────────>│
  │                         │                       │                      │                       │
  │                         │                       │                      │      8) Detokenize    │
  │   SSE: token stream     │                       │                      │          (incremental)│
  │<─────────────────────────────────────────────────────────────────────────────────────────────── │
```

각 단계를 구체적으로 살펴보겠습니다.

### Step 1-2: 토큰화와 전처리

TokenizerManager는 텍스트를 토큰 ID로 변환하고 chat template을 적용합니다. vLLM과 동일한 역할이지만, SGLang은 멀티모달 입력(이미지, 비디오, 오디오)의 전처리도 이 단계에서 수행합니다.

### Step 3-4: RadixCache Prefix Matching

**이 단계가 SGLang의 핵심 차별점입니다.** 새 요청이 들어오면 Scheduler는 즉시 RadixCache에서 prefix matching을 수행합니다.

```
예: "당신은 금융 분석가입니다. 삼성전자를 분석해주세요."가 입력되었을 때

RadixCache (Radix Tree):
         [root]
           │
    ┌──────┴──────┐
    │             │
 [당신은 금융     [You are a
  분석가입니다]    helpful...]
    │
 ┌──┴──┐
 │     │
[삼성  [LG전자를
전자를  분석해...]
분석...]

→ "당신은 금융 분석가입니다" 까지 캐시 히트!
→ "삼성전자를 분석해주세요" 부분만 새로 prefill하면 됨
```

이 prefix matching의 결과(cache hit 비율)가 `waiting_queue` 내 요청의 우선순위를 결정합니다. cache hit rate가 높은 요청을 먼저 처리하면 prefill 연산량을 줄이면서도 처리량을 극대화할 수 있습니다.

RadixAttention의 상세 구조와 PagedAttention과의 비교는 **Part 2**에서 깊이 있게 다룹니다.

### Step 5: 배치 구성 전략

SGLang의 스케줄러는 **Decode 우선** 정책을 따릅니다.

```
배치 구성 순서:
1. running_batch의 Decode 요청 먼저 포함 (이미 생성 중인 요청 우선)
2. 남은 token budget 내에서 waiting_queue의 Prefill 요청 추가
   → cache hit rate가 높은 순서로 정렬하여 선택
3. 전체 배치의 토큰 수가 budget을 초과하지 않도록 조절
```

이 전략의 핵심은 Decode 요청의 지연 시간(TPOT)을 안정적으로 유지하면서, Prefill에서는 cache 재활용을 극대화하는 것입니다.

### Step 6-7: Forward Pass와 KV Cache 저장

GPU에서 Forward Pass가 실행된 후, 새로 계산된 KV cache는 RadixCache의 tree에 삽입됩니다. 이 KV cache는 이후 동일한 prefix를 가진 요청이 들어올 때 자동으로 재활용됩니다.

### Step 8: 스트리밍 출력

DetokenizerManager는 별도 프로세스에서 incremental detokenization을 수행합니다. 토큰이 생성될 때마다 바로 텍스트로 변환하여 SSE(Server-Sent Events) 스트림으로 클라이언트에 전달합니다.

## Overlap Scheduling: CPU/GPU 유휴 시간 제거

### 동기 스케줄링의 비효율

vLLM의 Async Scheduling과 유사한 문제의식에서 출발합니다. 동기 방식에서는 GPU가 Forward Pass를 실행하는 동안 CPU가 놀고, CPU가 다음 배치를 준비하는 동안 GPU가 놉니다.

```
동기 방식 (Sync Scheduling):
CPU: [배치1 준비]          [배치2 준비]          [배치3 준비]
GPU:            [배치1 실행]          [배치2 실행]          [배치3 실행]
                         ↑                    ↑
                     GPU 유휴              GPU 유휴
```

### SGLang의 Overlap Scheduling

SGLang은 **OverlapThread**를 통해 CPU 준비 작업을 GPU 실행과 겹칩니다.

```
Overlap Scheduling:
CPU: [배치1 준비][배치2 준비][배치3 준비][배치4 준비]
GPU:            [배치1 실행][배치2 실행][배치3 실행]
                ↑
            GPU 유휴 시간 없음
```

핵심 아이디어는 **CPU가 항상 한 배치 앞서서 준비**한다는 것입니다.

### Future Token Prediction

여기서 한 가지 기술적 도전이 있습니다. 배치 N의 결과(생성된 토큰)가 나오기 전에 배치 N+1을 준비해야 한다는 점입니다. 배치 N에서 각 Decode 요청이 어떤 토큰을 생성할지 모르는 상태에서 어떻게 다음 배치를 구성할 수 있을까요?

SGLang은 **Future Token** 개념으로 이를 해결합니다.

```
배치 N 실행 중 (GPU):
  요청 A: "삼성" → [???] (아직 토큰 미생성)
  요청 B: "LG"  → [???]

배치 N+1 준비 중 (CPU):
  요청 A: 다음 토큰이 뭔지 모르지만, "1토큰이 생성될 것"이라고 가정
           → KV cache 슬롯 1개 예약, 메타데이터 준비
  요청 B: 동일하게 1토큰 예약

배치 N 완료 후:
  실제 생성된 토큰으로 Future Token을 교체
  → 이미 준비된 메타데이터와 메모리 할당은 유효
```

Decode 단계에서는 각 요청이 정확히 1개 토큰을 생성하므로, 이 가정은 거의 항상 정확합니다. SGLang은 이 예측 기반 준비로 CPU 오버헤드를 GPU 실행 시간 뒤로 완전히 숨깁니다.

### Overlap되는 CPU 작업들

OverlapThread가 GPU 실행과 병렬로 수행하는 작업들은 다음과 같습니다.

```
GPU에서 배치 N 실행 중, CPU에서 동시 수행:
├── RadixCache prefix matching (새 요청의 캐시 히트 확인)
├── KV cache 메모리 할당 (새 토큰을 위한 슬롯 예약)
├── Grammar constraint 준비 (구조화 출력의 FSM 상태 전이)
├── 배치 메타데이터 구성 (token IDs, positions, block tables)
└── Sampling 파라미터 준비 (temperature, top-p 등)
```

동기화는 `torch.cuda.Event`를 통해 이루어집니다. GPU가 배치 N의 실행을 완료하면 event를 signal하고, CPU는 이미 준비 완료된 배치 N+1을 즉시 GPU에 제출합니다.

### 성능 효과

SGLang v0.4 블로그에 따르면, Overlap Scheduling 도입으로 **Decode throughput이 v0.3 대비 1.9배** 향상되었습니다. GPU 프로파일링에서 연속된 배치 간 GPU 유휴 시간이 사실상 제거된 것을 확인할 수 있습니다.

이 접근은 vLLM V1의 Async Scheduling과 개념적으로 유사하지만, 구현 세부사항에서 차이가 있습니다. vLLM은 `asyncio` 기반의 비동기 파이프라인을, SGLang은 전용 `OverlapThread`를 사용합니다. 두 접근 모두 "CPU 준비를 GPU 실행과 겹친다"는 동일한 목표를 달성합니다.

## FlashInfer: SGLang의 Attention Backend

SGLang은 기본 Attention Backend으로 **FlashInfer**를 사용합니다. FlashInfer는 MLSys 2025에서 발표된 별도의 연구 프로젝트로, SGLang과 밀접하게 공동 개발되었습니다.

### FlashInfer가 해결하는 문제

LLM 서빙에서 Attention 연산은 단순하지 않습니다. 요청마다 KV cache 길이가 다르고, prefix sharing으로 물리적 메모리가 비연속적이며, CUDA Graph를 쓰려면 정적 텐서 형태가 필요합니다. 이 세 가지 제약이 동시에 존재합니다.

FlashInfer는 이를 **Block-sparse KV cache format**과 **JIT 컴파일 Attention 커널**로 해결합니다.

```
전통적 Attention:
  Q × K^T → 연속 메모리 가정 → 비연속 KV cache에서 비효율

FlashInfer:
  Q × K^T → Block-sparse format으로 비연속 블록을 직접 인덱싱
           → JIT 컴파일로 head_dim, dtype 등에 최적화된 커널 생성
           → CUDA Graph와 호환되는 load-balanced scheduling
```

### 핵심 기술 요소

**1) Composable Block-sparse Format**

KV cache 블록이 물리적으로 흩어져 있어도 하나의 Attention 연산으로 처리할 수 있는 인덱싱 구조를 제공합니다. RadixAttention의 tree 구조와 자연스럽게 결합됩니다.

**2) JIT-compiled Attention Templates**

head dimension, data type, causal mask 여부 등에 따라 최적화된 CUDA 커널을 런타임에 컴파일합니다. 모든 모델 변형에 대해 하나의 범용 커널을 쓰는 대신, 특화된 커널을 자동 생성합니다.

**3) Load-balanced Scheduling for CUDA Graph**

CUDA Graph는 GPU 연산을 캡처하여 재실행함으로써 CPU 오버헤드를 제거하지만, 입력 크기가 고정되어야 합니다. FlashInfer는 가변 길이 요청들을 고정 크기 워크로드로 재분배하는 load-balanced scheduling으로 이 제약을 해결합니다.

논문에 따르면, FlashInfer는 inter-token latency를 29-69% 줄이고, long-context 시나리오에서 28-30%의 지연 시간 감소를 달성했습니다.

## vLLM V1과의 설계 철학 비교

아키텍처 분석을 마무리하며, 두 엔진의 설계 철학을 비교해 보겠습니다.

### vLLM: "단일 요청의 효율성 극대화"

vLLM의 핵심 혁신인 PagedAttention은 **단일 요청 내부**의 KV cache 메모리 효율을 극적으로 개선했습니다. 고정 크기 블록으로 fragmentation을 4% 이하로 줄이고, continuous batching으로 GPU 활용률을 높였습니다.

요청 간 prefix sharing(APC)은 이후 추가된 기능으로, hash 기반의 블록 매칭을 사용합니다.

### SGLang: "LLM 프로그램의 실행 효율성 극대화"

SGLang은 **"요청은 독립적이지 않다"**는 가정에서 출발합니다. 동일한 system prompt, multi-turn 대화, few-shot 예시 등으로 요청 간에 대량의 prefix가 공유됩니다. RadixAttention은 이 공유를 **아키텍처의 1등 시민(first-class citizen)**으로 취급합니다.

이 차이는 아키텍처 전반에 영향을 미칩니다.

| 설계 결정 | vLLM | SGLang |
|-----------|------|--------|
| **스케줄링 우선순위** | 요청 도착 순서 + 공정성 | Cache hit rate 기반 |
| **KV cache 자료구조** | Flat hash table | Hierarchical tree |
| **Prefix 재활용** | 선택적 최적화 (APC) | 핵심 설계 원칙 |
| **최적화 대상** | 개별 요청의 latency, throughput | 프로그램(요청 집합)의 총 실행 시간 |

이는 "어느 것이 더 좋다"의 문제가 아니라, **최적화 대상이 다르다**는 것입니다. 단일 요청의 처리 성능만 보면 두 엔진의 차이는 크지 않을 수 있지만, prefix sharing이 빈번한 워크로드에서 SGLang의 이점이 극대화됩니다.

## 마무리

이 글에서는 SGLang의 논문에서 제기한 문제의식, Frontend DSL의 설계, Backend Runtime의 전체 아키텍처, Overlap Scheduling, FlashInfer 통합, 그리고 vLLM과의 설계 철학 차이를 살펴봤습니다.

핵심을 정리하면 다음과 같습니다.

- SGLang은 **LLM 프로그램**이라는 관점에서 서빙 엔진을 재설계했습니다.
- **RadixAttention**은 KV cache를 radix tree로 관리하여 요청 간 prefix 재활용을 자동화합니다.
- **Overlap Scheduling**은 CPU 준비 작업을 GPU 실행과 겹쳐 유휴 시간을 제거합니다.
- **FlashInfer**는 block-sparse KV cache와 JIT 커널로 Attention 연산을 최적화합니다.
- vLLM이 단일 요청 효율에 집중한다면, SGLang은 요청 간 관계의 활용에 집중합니다.

다음 Part 2에서는 이 글에서 개념만 소개한 **RadixAttention**의 내부 구조를 깊이 파고들겠습니다. Radix tree의 자료구조, prefix matching 알고리즘, cache-aware scheduling, 그리고 PagedAttention과의 상세 벤치마크 비교를 다룰 예정입니다.

## 참고 자료

- Zheng, L. et al. (2024). *SGLang: Efficient Execution of Structured Language Model Programs*. NeurIPS 2024. [arXiv:2312.07104](https://arxiv.org/abs/2312.07104)
- Ye, Z. et al. (2025). *FlashInfer: Efficient and Customizable Attention Engine for LLM Inference Serving*. MLSys 2025. [arXiv:2501.01005](https://arxiv.org/abs/2501.01005)
- LMSYS. (2024). *Fast and Expressive LLM Inference with RadixAttention and SGLang*. [LMSYS Blog](https://lmsys.org/blog/2024-01-17-sglang/)
- LMSYS. (2024). *SGLang v0.4: Zero-Overhead Batch Scheduler, Cache-Aware Load Balancer, and Faster Structured Outputs*. [LMSYS Blog](https://lmsys.org/blog/2024-12-04-sglang-v0-4/)
- SGLang Documentation. [docs.sglang.ai](https://docs.sglang.ai/)
- SGLang GitHub Repository. [github.com/sgl-project/sglang](https://github.com/sgl-project/sglang)
