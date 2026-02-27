---
layout: single
title: "vLLM 내부 구조: CPU 스케줄링과 GPU Forward Pass, 그리고 Async Scheduling"
date: 2026-02-08 10:00:00 +0900
last_modified_at: 2026-02-18
categories: mlops
tags: [vllm, llm-serving, gpu, cuda, inference, scheduling, async-scheduling, paged-attention, continuous-batching]
excerpt: "vLLM은 왜 필요한가? LLM 모델 자체는 토큰을 받아 logits을 출력하는 함수일 뿐인데, 수천 명이 동시에 요청을 보내면 누가 배치를 구성하고, 메모리를 관리하고, GPU를 쉬지 않게 할 것인가? 서빙 엔진의 역할부터 CPU 스케줄링과 GPU Forward Pass의 분리, Async Scheduling의 파이프라인 구조까지 vLLM V1의 내부를 깊이 있게 살펴봅니다."
---

## 들어가며

`vllm serve meta-llama/Llama-3.3-70B-Instruct --tensor-parallel-size 4`

vLLM을 사용해본 분이라면 익숙한 명령어입니다. 이 한 줄로 70B 파라미터 모델이 서빙되고, 수천 건의 동시 요청을 처리하기 시작합니다.

그런데 내부에서는 정확히 어떤 일이 벌어질까요? "요청이 들어오면 모델이 토큰을 생성한다" 정도는 알고 있지만, CPU와 GPU가 각각 어떤 역할을 분담하는지, 왜 비동기 스케줄링이 throughput을 높이는지, Python GIL이 왜 문제이고 어떻게 우회하는지를 정확히 설명할 수 있는 분은 많지 않을 겁니다.

이 글에서는 vLLM 공식 문서, 소스 코드, 그리고 핵심 기여자들의 설계 문서를 기반으로, 서빙 엔진이 필요한 근본적인 이유부터 CPU 스케줄링과 GPU Forward Pass의 분리, Async Scheduling의 파이프라인 구조까지 하나씩 파고들어 살펴보겠습니다.

## 서빙 엔진은 왜 필요한가

### LLM 모델 자체는 "함수"일 뿐

LLM 모델(Llama, DeepSeek 등)은 본질적으로 하나의 `torch.nn.Module`입니다. 입력 토큰을 받아 다음 토큰의 확률분포(logits)를 출력하는 순수한 수학 함수입니다.

```python
# LLM 모델 자체가 하는 일 (극단적으로 단순화)
logits = model(input_ids, positions, kv_cache)
next_token = sample(logits)
```

이것이 전부입니다. 모델은 "누가 요청했는지", "GPU 메모리가 얼마나 남았는지", "다른 요청이 대기 중인지" 같은 것은 전혀 모릅니다. 모델에게 이런 정보를 알려주고, 최적의 조건으로 실행시키는 것이 서빙 엔진의 역할입니다.

### HuggingFace transformers로 직접 서빙하면?

서빙 엔진 없이 `transformers`의 `model.generate()`를 직접 사용하면 어떻게 될까요?

```python
# Naive한 서빙 (서빙 엔진 없이)
for request in requests:
    output = model.generate(request.input_ids, max_new_tokens=256)
    # 한 요청이 끝나야 다음 요청 처리
```

이 방식에는 세 가지 근본적인 문제가 있습니다.

**문제 1: GPU 활용률의 낭비**

Decode 단계에서 GPU는 단 1개 토큰을 생성하기 위해 모델의 전체 가중치(수십 GB)를 메모리에서 읽어옵니다. 이때 GPU 연산 유닛(Tensor Core)의 대부분은 놀고 있습니다. 데이터가 HBM에서 SM(Streaming Multiprocessor)으로 전송되기를 기다리는 것이 병목이기 때문입니다(memory-bandwidth bound).

동시에 여러 요청의 토큰을 배치로 묶으면 동일한 메모리 로딩 비용으로 N개 토큰을 한 번에 생성할 수 있는데, 단일 요청 순차 처리로는 이 이점을 전혀 활용할 수 없습니다.

**문제 2: 메모리 관리의 부재**

각 요청은 생성하는 토큰마다 KV cache가 누적됩니다. 요청 A는 100토큰, 요청 B는 5000토큰일 수 있는데, 정적으로 최대 길이만큼 메모리를 미리 할당하면 대부분의 경우 큰 낭비가 발생합니다. 반대로 부족하면 OOM(Out of Memory)으로 서비스가 중단됩니다.

**문제 3: Static Batching의 비효율**

Static batching에서는 배치 내 모든 요청이 끝날 때까지 기다린 후 다음 배치를 시작합니다. 이미 생성을 완료한 짧은 요청이 긴 요청을 기다리며 GPU 자원을 점유합니다.

### 서빙 엔진이 담당하는 영역

서빙 엔진(vLLM, SGLang 등)은 모델과 외부 세계 사이의 **모든 오케스트레이션**을 담당합니다. 모델 자체가 담당하는 영역과 명확히 분리됩니다.

```
[사용자 요청들] → [서빙 엔진 영역] → [모델 영역]
                  │                    │
                  │  ┌─────────────┐   │  ┌──────────────┐
                  │  │ API Server  │   │  │ torch.nn.    │
                  │  │ Scheduler   │   │  │ Module       │
                  │  │ KV Cache Mgr│   │  │ (Attention,  │
                  │  │ Tokenizer   │   │  │  FFN 등)     │
                  │  │ Sampler     │   │  │              │
                  │  │ Batching    │   │  │ GPU Kernels  │
                  │  │ Memory Mgr  │   │  │ (FlashAttn,  │
                  │  │ Parallelism │   │  │  PagedAttn)  │
                  │  └─────────────┘   │  └──────────────┘
```

각 영역의 역할을 구체적으로 보면 다음과 같습니다.

| 영역 | 서빙 엔진 (vLLM) | LLM 모델 |
|-----|-----------------|---------|
| 스케줄링 | 어떤 요청을, 몇 토큰씩, 어떤 순서로 처리할지 결정 | 관여하지 않음 |
| 메모리 | PagedAttention으로 KV cache block 동적 할당/해제 | 주어진 block table에 따라 KV 읽기/쓰기만 수행 |
| 배치 | Continuous batching으로 요청 동적 추가/제거 | 받은 배치를 그대로 연산 |
| 병렬화 | TP/PP/EP worker 생성, 통신 조율 | 가중치가 이미 샤딩된 상태로 로드됨 |
| 토큰화 | 텍스트 ↔ 토큰 ID 변환 | 토큰 ID만 입력받음 |
| 샘플링 | temperature, top-p, top-k, guided decoding 적용 | logits만 출력 |
| API | OpenAI-compatible HTTP/gRPC 엔드포인트 제공 | 없음 |

![vLLM LLM Engine 구조](/assets/images/posts/vllm/vllm_llm_engine.png)

핵심은 **모델은 "이번 배치의 토큰 → logits"라는 순수 함수만 수행**하고, 그 전후의 모든 오케스트레이션이 서빙 엔진의 역할이라는 점입니다. `transformers`의 `generate()`를 직접 쓰는 것과 vLLM을 쓰는 것의 throughput 차이가 보통 5~20배에 달하는 이유가 여기에 있습니다.

## vLLM V1 아키텍처 개요

서빙 엔진의 역할을 이해했으니, vLLM V1의 전체 아키텍처를 보겠습니다. 각 컴포넌트가 CPU 스케줄링과 GPU Forward Pass에서 어떤 위치에 있는지 파악하는 데 도움이 됩니다.

```
┌──────────────────────────────────────────────────────┐
│  프로세스 1: API Server / AsyncLLM                    │
│                                                      │
│  ┌────────────────┐  ┌──────────────┐                │
│  │ HTTP Server    │  │ Tokenizer /  │                │
│  │ (FastAPI)      │  │ Detokenizer  │                │
│  └───────┬────────┘  └──────────────┘                │
│          │                                           │
│          │ ZeroMQ IPC                                │
└──────────┼───────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────┐
│  프로세스 2: EngineCore                               │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  Scheduler                                  │      │
│  │  ├─ waiting queue (새 prefill 요청)          │      │
│  │  ├─ running queue (decode 중인 요청)         │      │
│  │  ├─ KVCacheManager                          │      │
│  │  │   └─ free_block_queue (가용 KV 블록 풀)  │      │
│  │  └─ StructuredOutputManager (FSM)           │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  ModelExecutor                              │      │
│  │  └─ Worker 관리, forward pass 트리거         │      │
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
│  │ ├─ InputBatch │   │ ├─ InputBatch │              │
│  │ ├─ Model      │   │ ├─ Model      │              │
│  │ │  (nn.Module)│   │ │  (nn.Module)│              │
│  │ └─ CUDA Graphs│   │ └─ CUDA Graphs│              │
│  └───────────────┘   └───────────────┘              │
└──────────────────────────────────────────────────────┘
```

vLLM V1의 핵심 설계 결정은 **각 역할을 별도 프로세스로 분리**한 것입니다. API Server, EngineCore, GPU Worker가 각각 독립된 프로세스로 실행됩니다. 이 분리가 왜 필요한지는 이후 Python GIL 섹션에서 자세히 다루겠습니다.

![vLLM V1 Process Architecture (TP=4)](/assets/images/posts/vllm/vllm_v1_process_architecture_tp4.png)

## Engine Step: CPU 스케줄링과 GPU Forward Pass

vLLM이 토큰을 생성하려면 매 **engine step**마다 두 가지 핵심 작업이 실행됩니다.

```
[Engine Step N]
  ├── (1) CPU 스케줄링    → CPU에서 실행
  └── (2) GPU Forward Pass → GPU에서 실행
```

### CPU 스케줄링: "이번 step에서 무엇을 처리할 것인가"

CPU 스케줄링은 **이번 step에서 어떤 요청들을 얼마만큼 처리할지 CPU가 결정하는 과정** 전체를 말합니다. 구체적으로 다음 작업들이 포함됩니다.

**a) Scheduler의 배치 결정**

vLLM V1의 스케줄러는 스케줄링 결과를 `{request_id: num_tokens}` 형태의 딕셔너리로 표현합니다. 이 단순한 표현 하나로 chunked prefill, prefix caching, speculative decoding을 모두 커버합니다.

```
Scheduler 동작:

1. running 큐 순회 (이미 decode 중인 요청)
   ├── 각 요청에 대해 새 토큰 수 결정 (보통 1개)
   ├── KVCacheManager.allocate_slots() 호출
   └── token budget 차감

2. waiting 큐 순회 (새 prefill 요청)
   ├── token budget 내에서 할당 가능한 만큼
   ├── KVCacheManager.allocate_slots() 호출
   ├── 요청을 waiting → running으로 이동
   └── token budget 차감

결과: {req_1: 1, req_2: 1, req_3: 128, req_4: 1}
       ↑ decode    ↑ decode    ↑ prefill     ↑ decode
```

스케줄러는 **decode 요청을 우선** 처리합니다. 이미 진행 중인 요청의 latency를 보장하기 위해서입니다. 정책은 FCFS(선착순)와 Priority(우선순위) 중 선택할 수 있습니다.

**b) Input 준비 (prepare_inputs)**

스케줄링이 끝나면 GPU에 전달할 텐서를 CPU에서 조립합니다.

```
prepare_inputs 과정:

1. input_ids 구성
   [req_1의 토큰][req_2의 토큰][req_3의 128토큰][req_4의 토큰]
   → 모든 요청의 토큰을 하나로 flatten

2. positions 계산
   [500][300][0,1,2,...,127][150]
   → 각 토큰의 position index

3. slot_mapping 구성
   → 각 토큰이 KV cache의 어느 block/slot에 매핑되는지

4. attention metadata 구성
   → FlashAttention 백엔드 설정, block table 등

5. CPU → GPU 메모리 복사 (buffer transfer)
```

**c) 기타 CPU 작업**

이전 step의 결과에 대한 후처리도 CPU에서 수행됩니다. output token의 detokenization(토큰 ID → 텍스트 변환), stop condition 체크(EOS, max_tokens, stop strings), structured output의 FSM(유한 상태 기계) bitmask 업데이트, 완료된 요청의 KV cache block 반환 등이 여기에 해당합니다.

### GPU Forward Pass: 모델의 실제 연산

GPU Forward Pass는 **Transformer 모델의 neural network를 실행하는 단계**입니다. 모든 레이어의 가중치를 적용하여 입력 토큰으로부터 logits을 계산합니다.

```
Forward Pass 내부 (Transformer 아키텍처):

input_ids
    │
    ▼
Embedding Layer (토큰 ID → hidden state 벡터)
    │
    ▼
┌─────────────────────────────────────────────┐
│  Transformer Block × N layers               │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ RMSNorm                             │    │
│  │         ▼                           │    │
│  │ Self-Attention                      │    │
│  │ ├─ Q, K, V projection (Linear)     │    │
│  │ ├─ RoPE (positional encoding)      │    │
│  │ ├─ PagedAttention kernel           │    │
│  │ │   (FlashAttention 등)            │    │
│  │ └─ Output projection (Linear)      │    │
│  │         ▼                           │    │
│  │ RMSNorm                             │    │
│  │         ▼                           │    │
│  │ FFN / MLP                           │    │
│  │ ├─ Gate + Up projection             │    │
│  │ ├─ SiLU activation                  │    │
│  │ └─ Down projection                  │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
    │
    ▼
LM Head (Linear → logits)
    │
    ▼
Sampling (temperature, top-p, top-k 등 적용)
    │
    ▼
output_token_ids
```

이 과정에서 두 가지 실행 모드가 있습니다.

**Eager 모드**: 표준 PyTorch forward pass를 그대로 실행합니다. 디버깅에 유용하지만 커널 런치 오버헤드가 있습니다.

**CUDA Graph 모드**: 엔진 초기화 시 다양한 배치 크기에 대해 GPU 연산 시퀀스를 미리 캡처(recording)해두고, 실행 시 캡처된 그래프를 replay합니다. 커널 런치 오버헤드를 제거하여 latency를 줄입니다.

### Forward Pass는 Prefill인가, Decode인가?

**둘 다 포함합니다.** GPU Forward Pass는 "모델에 토큰을 넣고 logits을 뽑는 것" 전체를 의미하므로, prefill이든 decode든 모델이 GPU에서 실행되는 모든 연산이 forward pass입니다.

vLLM V1에서는 하나의 forward pass에 prefill 요청과 decode 요청을 **혼합**할 수 있습니다.

```
하나의 Forward Pass에 들어가는 토큰들:

[요청A decode 1토큰][요청B decode 1토큰][요청C prefill 128토큰][요청D decode 1토큰]
                    ↓ 전부 flatten (연결)
[131개 토큰의 단일 시퀀스] → GPU에서 한 번의 forward pass로 처리
```

각 요청은 position index와 attention mask로 구분됩니다. 각 요청은 자기 토큰에만 attend하고, FlashAttention 같은 커널이 이를 효율적으로 처리합니다. 이것이 **continuous batching**이 가능한 이유입니다. V0 엔진에서는 prefill과 decode를 분리해서 실행해야 했지만, V1에서는 하나의 step에서 혼합할 수 있게 되었습니다.

단, prefill과 decode는 **연산 특성이 근본적으로 다릅니다**.

```
Prefill Forward Pass:

입력: 프롬프트 토큰 N개 (수백~수만)
  → Attention(Q[N], K[N], V[N]) → N×N 크기의 attention 연산
  → FFN([N]) → N개 토큰의 MLP
  → KV cache에 새로 저장

특성: Compute-bound
  GPU 연산 유닛을 빽빽하게 사용
  병목 = GPU 연산 처리량
```

```
Decode Forward Pass:

입력: 직전 생성 토큰 1개
  → Q = Linear(hidden[1]) → 1개 토큰의 Q만 새로 계산
  → Attention(Q[1], K[전체], V[전체]) → 1×(지금까지 전체) attention
  → FFN([1]) → 1개 토큰의 MLP
  → KV cache에 1개 추가

특성: Memory-bandwidth-bound
  단 1개 토큰인데 모든 레이어의 가중치(수십 GB)를 메모리에서 읽어야 함
  GPU 연산 유닛 대부분이 대기 상태
  병목 = HBM → SM 데이터 전송 대역폭
```

Decode가 memory-bandwidth-bound인 이유가 중요합니다. 단 1개 토큰을 위해서도 전체 모델 가중치와 이전 토큰들의 KV cache를 HBM에서 전부 읽어와야 합니다. 이때 여러 요청을 배치로 묶으면, 동일한 가중치 로딩 비용으로 여러 토큰을 동시에 처리할 수 있습니다. 이것이 continuous batching이 throughput을 극적으로 높이는 원리입니다.

## Python GIL과 vLLM의 멀티프로세싱 아키텍처

### GIL이란

Python(CPython)에는 **Global Interpreter Lock**이라는 뮤텍스가 존재합니다. 이것은 한 시점에 오직 하나의 스레드만 Python 바이트코드를 실행할 수 있도록 강제하는 락입니다.

```
[Python 프로세스]
  Thread A: "실행할래" → GIL 획득 → 실행 중 → GIL 반환
  Thread B: "나도!"    → GIL 대기...        → GIL 획득 → 실행 → 반환
  Thread C: "나도!"    → GIL 대기...                   → GIL 대기...
```

멀티스레딩을 사용해도 CPU-bound Python 작업은 실질적으로 병렬 실행이 되지 않습니다.

### GIL이 존재하는 이유

CPython의 메모리 관리는 reference counting 방식인데, 이것이 thread-safe하지 않기 때문입니다. 모든 Python 객체는 참조 카운터(`ob_refcnt`)를 가지며, 여러 스레드가 동시에 이 값을 수정하면 race condition이 발생합니다. GIL은 이를 가장 단순하게 방지하는 방법입니다.

### GIL이 vLLM에 미치는 영향

vLLM의 EngineCore에서는 여러 CPU 작업이 실행되어야 합니다. 만약 모든 것이 하나의 프로세스 안에 있다면 GIL 때문에 이 작업들이 동시에 실행될 수 없습니다.

```
만약 단일 프로세스라면 (GIL 문제 발생):

├── HTTP 요청 수신/응답          ← CPU-bound, GIL 필요
├── Tokenization / Detokenization ← CPU-bound, GIL 필요
├── 스케줄링 + input 준비         ← CPU-bound, GIL 필요
├── Structured output FSM 업데이트 ← CPU-bound, GIL 필요
└── GPU forward pass 트리거       ← I/O-bound, GIL 해제됨
```

CUDA 커널 런치나 네트워크 I/O 같은 작업은 C 레벨에서 GIL을 **해제(release)**한 상태로 실행됩니다. 따라서 GPU forward pass 자체는 GIL에 영향을 받지 않습니다. 문제는 그 사이사이의 순수 Python 로직(스케줄링 결정, 텐서 조립, 상태 업데이트 등)입니다.

```python
# GIL이 문제되는 부분 (Python 바이트코드 실행)
scheduler_output = scheduler.schedule()           # GIL 잡고 실행
input_tensors = prepare_inputs(scheduler_output)  # GIL 잡고 실행

# GIL이 문제되지 않는 부분 (C/CUDA 레벨)
model.forward(input_tensors)  # 내부적으로 GIL 해제 후 CUDA 실행
```

### vLLM V1의 해결: 멀티프로세싱으로 GIL 우회

GIL은 **프로세스 단위**이므로, 별도 프로세스로 분리하면 해결됩니다. vLLM V1은 이 원칙을 적극 활용합니다.

```
[프로세스 1: AsyncLLM]              ← 자체 GIL
  ├── HTTP 수신/응답
  ├── Tokenization / Detokenization
  └── ZeroMQ IPC로 EngineCore와 통신
           │
           │ (프로세스 간 통신 — GIL 무관)
           ▼
[프로세스 2: EngineCore]            ← 자체 GIL
  ├── Scheduler
  ├── KV Cache Manager
  └── ModelExecutor
           │
           ▼
[프로세스 3~N: GPU Workers]         ← 각각 자체 GIL
  ├── Worker 0 (GPU 0)
  ├── Worker 1 (GPU 1)
  └── ...
```

각 프로세스가 독립된 GIL을 가지므로, AsyncLLM이 tokenization을 수행하는 동안 EngineCore는 스케줄링을 동시에 실행할 수 있습니다. 프로세스 간 통신은 **ZeroMQ**(비동기 메시징 라이브러리)를 사용합니다.

V0에서는 Scheduler와 Worker 0이 같은 프로세스에 공존하여 비대칭 구조였지만, V1에서는 incremental diff 방식으로 워커에 상태 변경분만 전달하여 프로세스를 완전히 분리했습니다.

## Async Scheduling: CPU와 GPU의 파이프라인

### 동기 실행의 문제

기본(동기) 모드에서는 CPU 스케줄링과 GPU Forward Pass가 **순차적으로** 실행됩니다.

```
동기 실행 (Sync Scheduling):

시간 →
CPU: [Schedule N][Prepare N]··········[Schedule N+1][Prepare N+1]··········
GPU: ················[Forward N]·····················[Forward N+1]·····
                     ↑                              ↑
              CPU 끝나야 시작                 GPU 끝나야 CPU 시작
```

GPU forward가 실행되는 동안 CPU는 놀고 있고, CPU가 스케줄링하는 동안 GPU는 놀고 있습니다. GPU가 빠른 환경(예: Llama-8B on H100에서 forward ~5ms)에서 CPU 오버헤드(~4ms)가 전체 시간의 거의 절반을 차지하게 됩니다. GPU가 빨라질수록 이 문제는 심해집니다.

### Async Scheduling: 파이프라인화

Async scheduling은 CPU 스케줄링과 GPU Forward Pass를 **오버랩**시킵니다.

```
비동기 실행 (Async Scheduling):

시간 →
CPU: [Schedule N][Prepare N][Schedule N+1][Prepare N+1][Schedule N+2]···
GPU: ············[Forward N]·············[Forward N+1]·············
                              ↑ overlap! ↑
```

Step N의 GPU forward가 실행되는 동안, CPU는 기다리지 않고 Step N+1의 스케줄링을 미리 시작합니다.

여기서 핵심적인 문제가 있습니다. **Step N의 실제 출력 토큰을 아직 모르는 상태에서 N+1을 스케줄링해야 한다**는 점입니다.

```
문제:
  Step N이 GPU에서 실행 중
  → 아직 어떤 토큰이 생성될지 모름
  → 그런데 Step N+1의 스케줄링을 시작해야 함
  → 입력 토큰을 뭘로 설정하지?

해결:
  Decode 요청은 "어떤 토큰이든 정확히 1개가 생성될 것"이라고 가정
  → KV cache slot을 미리 1개 할당
  → 나중에 실제 토큰이 확정되면 비동기적으로 input_ids를 업데이트
```

vLLM 소스에서 `AsyncScheduler` 클래스(`vllm/v1/core/sched/async_scheduler.py`)가 이 로직을 담당합니다. `_update_after_schedule`이 스케줄링 후 상태를 업데이트하고, `_update_request_with_output`이 GPU 결과가 돌아오면 실제 토큰으로 교체합니다.

### 성능 효과

벤치마크 결과는 GPU가 빠른 환경일수록 효과가 큽니다.

```
Async Scheduling 벤치마크 (PR #23569 기준):

Qwen2.5-VL-7B-Instruct:
  동기: TPOT 29.16ms → 비동기: TPOT 23.22ms (20.3% 개선)

Qwen3-32B (TP=4):
  동기: TPOT 44.20ms → 비동기: TPOT 41.73ms (5.6% 개선)
```

모델이 작을수록(forward가 빠를수록) CPU 오버헤드 비중이 커지므로 개선 효과가 큽니다. B200 같은 최신 GPU에서는 forward가 더 빨라지므로 async scheduling의 중요성이 더욱 커집니다.

vLLM 0.14.0부터 `--async-scheduling`이 기본 활성화되어, 별도 설정 없이 이 최적화가 적용됩니다.

## 전체 요청 흐름 타임라인

지금까지 살펴본 각 단계를 하나의 요청이 처리되는 시간순으로 정리하면 다음과 같습니다.

```
t=0ms    POST /v1/chat/completions 도착
         │
t=1ms    AsyncLLM (프로세스 1):
         ├─ 인증/검증
         ├─ Tokenization: "Hello, how are you?" → [15496, 11, 1268, 527, 498, 30]
         └─ ZeroMQ IPC로 EngineCore에 전송
         │
t=3ms    EngineCore (프로세스 2):
         ├─ Request 객체 생성, waiting 큐에 추가
         │
t=5ms    Scheduler: Engine Step 시작
         ├─ running 큐의 기존 decode 요청들 처리
         ├─ waiting 큐에서 이 요청을 꺼내 prefill 스케줄링
         ├─ KV cache block 할당 (6토큰 → ceil(6/16) = 1 block)
         └─ 요청을 running 큐로 이동
         │
t=7ms    prepare_inputs:
         ├─ input_ids, positions, slot_mapping 구성
         ├─ attention metadata 구성
         └─ CPU → GPU 메모리 복사
         │
t=8ms    GPU Forward Pass (프로세스 3, GPU Worker):
         ├─ Embedding → Transformer Blocks × N → LM Head
         ├─ Prefill: 6토큰 한 번에 처리
         ├─ KV cache 저장
         └─ Sampling → 첫 토큰 생성
         │
t=12ms   (Async: 이 동안 CPU는 이미 다음 step 스케줄링 시작)
         │
         ├─ [Decode Step 반복]
         │   ├─ CPU: 스케줄링 (1토큰 할당) + input 준비
         │   ├─ GPU: Forward Pass (1토큰) → 다음 토큰 생성
         │   └─ 반복... (EOS 또는 max_tokens까지)
         │
t=200ms  Stop condition 만족 (EOS 토큰 생성)
         ├─ KV cache block 반환 (free_block_queue로)
         ├─ EngineCore → AsyncLLM: 결과 전달 (ZeroMQ IPC)
         │
t=201ms  AsyncLLM:
         ├─ Detokenization: token_ids → "I'm doing well, thank you!"
         └─ HTTP Response 반환
```

## 핵심 설계 원칙

전체 흐름을 관통하는 vLLM V1의 설계 원칙을 정리합니다.

### CPU와 GPU의 역할 분리

CPU는 "무엇을 할지 결정"하고, GPU는 "실제로 실행"합니다. 이 분리 덕분에 각각을 독립적으로 최적화할 수 있고, async scheduling으로 파이프라인화가 가능합니다.

### 프로세스 분리를 통한 GIL 우회

Python GIL의 제약을 프로세스 분리로 해결합니다. AsyncLLM, EngineCore, GPU Worker가 각각 독립 프로세스로 실행되어 CPU-bound 작업이 서로를 블로킹하지 않습니다. 프로세스 간 통신은 ZeroMQ로 최소화합니다.

### Continuous Batching

요청을 동적으로 배치에 추가/제거하여 GPU가 항상 최대한의 배치를 처리하게 합니다. Static batching처럼 모든 요청이 끝날 때까지 기다리지 않습니다.

### Paged Attention

KV cache를 고정 크기 block(기본 16토큰) 단위로 동적 할당/해제합니다. 메모리 단편화를 방지하고, 다양한 길이의 요청을 효율적으로 처리합니다. 이 아이디어는 운영체제의 가상 메모리 페이징에서 영감을 받았으며, vLLM 프로젝트의 출발점이었던 PagedAttention 논문에서 제안되었습니다.

## 정리

vLLM 서빙 엔진의 핵심을 요약하면 다음과 같습니다.

| 개념 | 설명 |
|-----|------|
| 서빙 엔진의 역할 | 모델은 순수 함수(토큰 → logits)일 뿐, 스케줄링/메모리/배칭은 엔진이 담당 |
| CPU 스케줄링 | 배치 결정, input 준비, output 후처리 등 CPU에서 수행하는 오케스트레이션 |
| GPU Forward Pass | Transformer 모델의 실제 연산 (Prefill + Decode 모두 포함) |
| Async Scheduling | CPU/GPU를 파이프라인화하여 오버랩, GPU idle time 제거 |
| Python GIL 우회 | 멀티프로세싱으로 CPU-bound 작업의 병렬 실행 보장 |
| Continuous Batching | 요청을 동적으로 배치에 추가/제거, GPU 활용률 극대화 |

GPU가 빨라질수록 CPU 오버헤드의 상대적 비중이 커지고, 따라서 async scheduling과 프로세스 분리의 중요성도 커집니다. vLLM 0.14.0에서 async scheduling이 기본 활성화된 것은 이런 추세를 반영한 결정입니다.

## References

- [vLLM Official Documentation](https://docs.vllm.ai/en/latest/)
- [vLLM V1 Architecture Blog Post](https://blog.vllm.ai/2025/01/27/v1-alpha-release.html)
- [Inside vLLM: Anatomy of a High-Throughput LLM Inference System](https://www.aleksagordic.com/blog/vllm)
- [Life of an inference request (vLLM V1)](https://www.ubicloud.com/blog/life-of-an-inference-request-vllm-v1)
- [vLLM v0.14.0 Release Notes](https://github.com/vllm-project/vllm/releases/tag/v0.14.0)
- [Async Scheduling Plan - Issue #27679](https://github.com/vllm-project/vllm/issues/27679)
- [Async Scheduling PR #23569](https://github.com/vllm-project/vllm/pull/23569)
- [Efficient Memory Management for Large Language Model Serving with PagedAttention (2023)](https://arxiv.org/abs/2309.06180)
- [vLLM Architecture Overview](https://docs.vllm.ai/en/latest/design/arch_overview/)
