---
layout: single
title: "대규모 GPU 클러스터에서의 SGLang 운영 - EP, PD Disaggregation, HiCache, Speculative Decoding (SGLang 시리즈 Part 4)"
date: 2026-03-28 10:00:00 +0900
categories: mlops
tags: [sglang, gpu-cluster, expert-parallelism, disaggregated-serving, hicache, speculative-decoding, deepseek, llm-serving, h100]
excerpt: "96대의 H100 GPU에서 DeepSeek V3를 서빙하려면 어떤 기술이 필요할까요? Expert Parallelism으로 MoE 모델을 분산하고, Prefill/Decode를 분리하여 독립적으로 스케일링하고, 계층형 KV 캐싱으로 GPU 메모리의 한계를 넘고, Speculative Decoding으로 생성 속도를 2배 높이는 프로덕션 수준의 최적화 기법들을 분석합니다."
---

> 이 글은 **SGLang v0.5.9** (2026년 2월) 기준으로 작성되었습니다.

## 들어가며

[Part 1]({{ site.baseurl }}{% post_url 2026-03-26-sglang-architecture-deep-dive %})에서 SGLang의 전체 아키텍처를, [Part 2]({{ site.baseurl }}{% post_url 2026-03-27-sglang-radixattention-vs-pagedattention %})에서 RadixAttention을, [Part 3]({{ site.baseurl }}{% post_url 2026-03-27-sglang-compressed-fsm-structured-output %})에서 Compressed FSM을 다뤘습니다. 이 기술들은 **단일 서버** 수준에서 서빙 효율을 극대화하는 데 집중했습니다.

하지만 프로덕션 환경에서는 다른 차원의 문제가 등장합니다.

```
DeepSeek V3: 671B 파라미터, 256개 전문가(expert), MoE 아키텍처
→ 단일 GPU(80GB)에 적재 불가
→ 8대의 H100으로도 부족
→ 수십~수백 대의 GPU 클러스터가 필요

동시에 수천 명이 접속하는 서비스:
→ Prefill과 Decode의 리소스 요구가 다름
→ GPU 메모리만으로는 KV cache 부족
→ 생성 속도(TPOT)를 더 낮춰야 하는 요구
```

이 글에서는 SGLang이 대규모 GPU 클러스터에서 LLM을 운영하기 위해 제공하는 네 가지 핵심 기술을 분석합니다.

## 병렬화 전략 총정리

구체적인 기술을 다루기 전에, SGLang이 지원하는 병렬화 전략의 전체 그림을 먼저 정리하겠습니다.

```
┌─────────────────────────────────────────────────────────┐
│                    SGLang 병렬화 전략                      │
├─────────────┬──────────────┬──────────┬────────┬────────┤
│ Tensor      │ Pipeline     │ Expert   │ Data   │Context │
│ Parallelism │ Parallelism  │Parallel. │Parallel│Parallel│
│ (TP)        │ (PP)         │ (EP)     │ (DP)   │ (CP)   │
├─────────────┼──────────────┼──────────┼────────┼────────┤
│ 가중치를     │ 레이어를     │ 전문가를  │ 모델을  │시퀀스를 │
│ GPU 간      │ 단계별로     │ GPU 간   │ 복제   │ GPU 간 │
│ 분할        │ 분배         │ 분배     │        │ 분할   │
├─────────────┼──────────────┼──────────┼────────┼────────┤
│ All-Reduce  │ Point-to-    │ All-to-  │ 독립   │ Gather │
│ (NCCL)      │ Point P2P    │ All 통신 │ 실행   │        │
├─────────────┼──────────────┼──────────┼────────┼────────┤
│ --tp N      │ --pp N       │ --ep N   │ --dp N │--attn  │
│             │              │          │        │-cp N   │
├─────────────┼──────────────┼──────────┼────────┼────────┤
│ 단일 노드,  │ 200B+ 대형  │ MoE 모델 │ 처리량 │ 초장문  │
│ ≤200B 모델  │ 모델         │ 100B+    │ 스케일링│ 시퀀스 │
└─────────────┴──────────────┴──────────┴────────┴────────┘

전체 GPU 수 = tp_size × pp_size × ep_size × dp_size
```

실전에서 모델 크기와 하드웨어에 따른 권장 구성은 다음과 같습니다.

| 모델 | GPU | 구성 | 근거 |
|------|-----|------|------|
| Llama-70B | H100 x 8 | `tp=8` | 단일 노드에 적재 |
| Llama-70B | H100 x 16 | `tp=8, dp=2` | 2x 처리량 |
| Llama-405B | H100 x 16 | `tp=8, pp=2` | 2단계 파이프라인 |
| DeepSeek V3 (671B MoE) | H100 x 16 | `tp=8, ep=8` | 전문가 분산 |
| DeepSeek V3 | H100 x 96 | `tp=8, ep=8, dp=12` + PD 분리 | 프로덕션 규모 |

이제 각 기술을 깊이 살펴보겠습니다.

## Expert Parallelism: MoE 모델의 분산 서빙

### MoE 아키텍처와 EP의 필요성

DeepSeek V3/R1은 **MoE(Mixture of Experts)** 아키텍처를 사용합니다. 총 671B 파라미터 중, 각 토큰은 256개 전문가 중 8개만 활성화합니다. 활성 파라미터는 약 37B에 불과하지만, 전체 전문가의 가중치(671B)는 GPU 메모리에 적재되어 있어야 합니다.

**Tensor Parallelism(TP)** 은 각 전문가의 가중치를 GPU 간에 분할합니다. 하지만 MoE에서는 비효율적입니다. 256개 전문가의 가중치를 모두 분할하면 통신 오버헤드가 급격히 증가합니다.

**Expert Parallelism(EP)** 은 다른 접근을 취합니다. 전문가를 **통째로** 서로 다른 GPU에 배치합니다.

```
Tensor Parallelism (각 전문가를 분할):
  GPU 0: [Expert 0 의 1/8] [Expert 1 의 1/8] ... [Expert 255 의 1/8]
  GPU 1: [Expert 0 의 2/8] [Expert 1 의 2/8] ... [Expert 255 의 2/8]
  ...
  → 모든 전문가에 대해 All-Reduce 필요

Expert Parallelism (전문가를 통째로 배치):
  GPU 0: [Expert 0] [Expert 1] ... [Expert 31]    ← 32개 전문가 담당
  GPU 1: [Expert 32] [Expert 33] ... [Expert 63]
  ...
  GPU 7: [Expert 224] [Expert 225] ... [Expert 255]
  → 토큰을 해당 전문가가 있는 GPU로 라우팅 (All-to-All)
```

### MoE Forward Pass 파이프라인

EP에서 하나의 MoE 레이어를 처리하는 과정은 5단계로 이루어집니다.

```
입력 토큰들 (모든 GPU에 분산)
        │
        ▼
  ┌─────────────────┐
  │ 1. TopK Routing │  각 토큰이 활성화할 전문가 K개 선택
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 2. Dispatch     │  토큰을 해당 전문가가 있는 GPU로 전송
  │   (All-to-All)  │  DeepEP로 최적화된 통신
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 3. Pre-permute  │  GPU 내 토큰 재배치 (연산 최적화)
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 4. Grouped GEMM │  각 GPU에서 담당 전문가의 연산 수행
  │   (DeepGEMM)    │  FP8 block-wise quantized GEMM
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 5. Combine      │  결과를 원래 GPU로 모아서 합산
  │   (All-to-All)  │
  └────────┬────────┘
           ▼
     다음 레이어로
```

### DeepEP: 효율적인 토큰 라우팅

Dispatch(2단계)와 Combine(5단계)의 All-to-All 통신은 EP의 병목입니다. **DeepEP**는 DeepSeek이 공개한 통신 라이브러리로, 이 병목을 최적화합니다.

SGLang은 세 가지 DeepEP 모드를 제공합니다.

```bash
--deepep-mode normal       # Prefill 최적화: 높은 처리량, CUDA Graph 비호환
--deepep-mode low_latency  # Decode 최적화: CUDA Graph 호환, 마스크 기반 연산
--deepep-mode auto         # 런타임 자동 전환 (권장)
```

**Normal 모드**는 Prefill 단계에서 대량의 토큰을 한 번에 라우팅할 때 최적입니다. **Low-latency 모드**는 Decode 단계에서 소수의 토큰을 빠르게 라우팅할 때 최적이며, DeepGEMM 커널과 결합하여 통신과 연산을 오버랩합니다.

### EPLB: 전문가 부하 분산

MoE 모델의 라우터는 특정 전문가에 토큰이 편중되는 불균형을 만들어냅니다.

```
부하 분산 전:
  Expert 109: 671 활성화
  Expert 139: 713 활성화
  Expert 23:  42 활성화    ← 극심한 불균형
  GPU 워크로드 표준편차: 1227.908

EPLB(Expert Parallelism Load Balancer) 적용 후:
  활성화 통계를 분석하여 hot expert를 여러 GPU에 복제
  GPU 워크로드 표준편차: 2.867    ← 430배 개선
```

EPLB는 두 가지 전략을 사용합니다.
- **Hierarchical**: 노드 수가 전문가 그룹 수를 나눌 수 있을 때, 그룹을 노드에 할당한 뒤 노드 내에서 복제합니다.
- **Global**: 그룹 경계 없이 전역적으로 hot expert를 복제합니다.

### TBO: 연산-통신 오버랩

**Two-Batch Overlap(TBO)** 은 배치를 마이크로배치로 분할하여, 한 마이크로배치의 Attention 연산과 다른 마이크로배치의 All-to-All 통신을 오버랩합니다.

```
TBO 비활성:
  [Attention] → [Dispatch] → [GEMM] → [Combine] → [Attention] → ...
                  ↑ GPU 대기        ↑ 네트워크 대기

TBO 활성 (2개 마이크로배치):
  마이크로배치 A: [Attention] ─────────── [GEMM] ───────────
  마이크로배치 B: ──────── [Dispatch] ─────────── [Combine]
                  ↑ 연산과 통신이 오버랩
```

TBO는 피크 메모리를 절반으로 줄여 디바이스당 16,384 토큰 처리를 가능하게 합니다 (비활성 시 8,192에서 OOM).

### 96 H100 GPU 벤치마크

LMSYS 블로그에서 공개한 96-GPU DeepSeek V3 배포 결과입니다.

```
구성: 12 노드 × 8 H100 GPU (Atlas Cloud)
모델: DeepSeek V3/R1
설정: EP + DP + PD Disaggregation

성능 (2000 토큰 입력 기준):
  노드당 입력 처리량: 52,300 tok/s
  노드당 출력 처리량: 22,300 tok/s
  → 동일 리소스 대비 TP 전용 대비 5x 출력 처리량 향상
  → 오픈소스 최초로 DeepSeek 공식 성능에 근접
```

### EP 실행 예시

```bash
python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3 \
    --tp 8 --ep 8 \
    --moe-a2a-backend deepep \
    --deepep-mode auto \
    --moe-runner-backend deep_gemm \
    --enable-eplb \
    --enable-two-batch-overlap
```

## PD Disaggregation: Prefill과 Decode의 분리

### 왜 분리하는가

[이전 포스트]({{ site.baseurl }}{% post_url 2025-01-11-llm-inference-memory-bound %})에서 다뤘듯이, Prefill과 Decode는 근본적으로 다른 연산 특성을 가집니다.

```
Prefill (프롬프트 처리):
  → Compute-bound: 전체 프롬프트를 한 번에 병렬 처리
  → 높은 산술 강도 (Arithmetic Intensity)
  → GPU 연산 유닛을 최대로 활용
  → 큰 배치가 유리

Decode (토큰 생성):
  → Memory-bound: 한 번에 1개 토큰, 전체 가중치 로딩
  → 낮은 산술 강도
  → 메모리 대역폭이 병목
  → 많은 동시 요청 처리가 유리
```

하나의 엔진에서 두 작업을 같이 처리하면 **상호 간섭**이 발생합니다.

```
통합 엔진의 문제:
  시간 →
  [Decode batch] [Prefill 요청 도착!] [Prefill 처리] [Decode 재개]
                  ↑                                    ↑
            Decode가 중단됨                      TPOT 스파이크 발생
            (Prefill이 GPU를 점유)               (사용자가 느끼는 지연)
```

PD Disaggregation은 이 간섭을 **아키텍처적으로 제거**합니다.

### 분리 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                     Router (Gateway)                     │
│          요청을 Prefill 서버로 라우팅                      │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────┐
│     Prefill Server Pool      │
│                              │
│  ┌────────┐  ┌────────┐     │
│  │ GPU 0-7│  │ GPU 0-7│     │  Compute-bound 최적화
│  │ (TP=8) │  │ (TP=8) │     │  큰 배치, 높은 처리량
│  └───┬────┘  └───┬────┘     │
│      │           │          │
└──────┼───────────┼──────────┘
       │           │
       │  KV Cache Transfer (Mooncake / NIXL)
       │  RDMA 기반 고속 전송
       │           │
       ▼           ▼
┌──────────────────────────────┐
│      Decode Server Pool      │
│                              │
│  ┌────────┐  ┌────────┐     │
│  │ GPU 0-7│  │ GPU 0-7│     │  Memory-bound 최적화
│  │ (TP=8) │  │ (TP=8) │     │  많은 동시 요청, 낮은 지연
│  └────────┘  └────────┘     │
│                              │
└──────────────────────────────┘
```

### KV Cache 전송

Prefill 서버에서 계산된 KV cache를 Decode 서버로 전송해야 합니다. SGLang은 두 가지 전송 백엔드를 지원합니다.

**Mooncake** (Moonshot AI에서 개발)
- RDMA(Remote Direct Memory Access) 기반 zero-copy 전송
- NVLink, BareX, 노드 내 NVLink 메모리 풀 지원
- NVL72 환경에서는 `SGLANG_MOONCAKE_CUSTOM_MEM_POOL=NVLINK` 설정

**NIXL** (NVIDIA에서 개발)
- UCX 또는 LIBFABRIC 백엔드 선택 가능
- 비연속 메모리의 scatter-gather 전송 최적화

두 백엔드 모두 **비동기 전송**을 지원합니다. 별도 스레드 풀에서 KV cache 전송이 이루어져, Prefill 서버는 다음 요청을 즉시 처리할 수 있습니다.

```
환경 변수 설정:
  SGLANG_DISAGGREGATION_THREAD_POOL_SIZE  # 전송 워커 수 (기본: CPU 코어의 75% / 8)
  SGLANG_DISAGGREGATION_QUEUE_SIZE        # 병렬 전송 큐 (기본: 4)
```

### 독립적 스케일링

PD Disaggregation의 가장 큰 운영상 이점은 **독립적 스케일링**입니다.

```
상황 1: 긴 프롬프트 위주 트래픽 (RAG, 문서 분석)
  → Prefill 서버 증설, Decode는 현행 유지
  → TTFT 최적화에 집중

상황 2: 짧은 프롬프트 + 긴 생성 위주 (챗봇, 코드 생성)
  → Decode 서버 증설, Prefill은 현행 유지
  → TPOT 최적화에 집중

상황 3: 피크 타임
  → 양쪽 모두 증설
  → 각 풀의 --max-running-requests를 독립적으로 조절
```

### 배포 예시

```bash
# Prefill 서버
python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3-0324 \
    --disaggregation-mode prefill \
    --tp-size 16 --dp-size 8 \
    --enable-dp-attention \
    --moe-a2a-backend deepep \
    --mem-fraction-static 0.8 \
    --host 0.0.0.0 --port 30000

# Decode 서버
python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3-0324 \
    --disaggregation-mode decode \
    --tp-size 16 --dp-size 8 \
    --enable-dp-attention \
    --moe-a2a-backend deepep \
    --mem-fraction-static 0.8 \
    --max-running-requests 128 \
    --host 0.0.0.0 --port 30001

# Router (SGLang Model Gateway)
python -m sglang_router.launch_router \
    --pd-disaggregation \
    --prefill http://127.0.0.1:30000 \
    --decode http://127.0.0.1:30001 \
    --host 0.0.0.0 --port 8000
```

### 성능 효과

H800 2노드(16 GPU) 환경에서의 비교입니다.

| 구성 | 처리량 (req/s) | TTFT (ms) | TPOT (ms) |
|------|--------------|----------|----------|
| TP16 (통합) | 5.46 | 11,972 | 441 |
| TP16 + PD 분리 | 5.73 | **5,950** | **408** |
| 개선폭 | +5% | **-50%** | **-7%** |

TTFT가 50% 감소한 것이 핵심입니다. Decode 요청이 Prefill을 방해하지 않으므로 일관된 응답 시작 시간을 보장합니다.

## HiCache: 계층형 KV 캐싱

### GPU 메모리의 한계

Part 2에서 다룬 RadixAttention은 KV cache를 GPU 메모리에 보관합니다. 하지만 GPU 메모리는 유한합니다.

```
H100 80GB GPU:
  모델 가중치:     ~40GB (70B, FP8 기준)
  KV cache 가용:   ~30GB
  동시 요청 수:    ~60개 (시퀀스 길이에 따라)

요청이 더 많아지면?
  → 오래된 KV cache eviction
  → 다음에 같은 prefix가 오면 다시 계산 (캐시 미스)
  → Prefill 연산 낭비
```

### 3계층 캐시 아키텍처

HiCache는 CPU 메모리 시스템의 L1/L2/L3 캐시에서 영감을 받아, KV cache를 3계층으로 확장합니다.

```
┌─────────────────────────────────────┐
│  L1: GPU Memory (인스턴스 전용)      │
│  용량: ~30GB    속도: 최고           │
│  ← RadixAttention이 관리            │
└───────────────┬─────────────────────┘
                │ eviction / promotion
                ▼
┌─────────────────────────────────────┐
│  L2: CPU Memory (인스턴스 전용)      │
│  용량: ~64GB+   속도: 중간           │
│  ← HiRadixTree가 관리              │
└───────────────┬─────────────────────┘
                │ eviction / promotion
                ▼
┌─────────────────────────────────────┐
│  L3: Distributed Storage (클러스터 공유) │
│  용량: TB급     속도: 네트워크 의존    │
│  백엔드: Mooncake, 3FS, File 등      │
│  ← 여러 인스턴스가 공유 가능          │
└─────────────────────────────────────┘
```

### HiRadixTree

HiCache는 RadixAttention의 radix tree를 확장한 **HiRadixTree**를 사용합니다. 각 노드가 KV cache의 위치(GPU/CPU/L3)를 추적합니다.

```
기존 RadixCache TreeNode:
  value: tensor([0, 1, 2])  → GPU 메모리 인덱스만

HiRadixTree TreeNode:
  value: tensor([0, 1, 2])       → GPU 메모리 인덱스
  host_value: tensor([0, 1, 2])  → CPU 메모리 인덱스
  hash_value: ["sha256_a", ...]  → L3 스토리지 키
  ← 동일한 KV cache가 여러 계층에 동시 존재 가능
```

### Prefetch와 Write-back 정책

**Prefetch 정책** (하위 계층 → 상위 계층)

| 정책 | 동작 | 적합한 시나리오 |
|------|------|---------------|
| `best_effort` | 대기 없이 가용한 만큼만 로드 | 지연 시간 민감 |
| `wait_complete` | 전체 로드 완료까지 대기 | 캐시 히트율 우선 |
| `timeout` | 설정된 시간까지만 대기 | 균형 잡힌 기본값 |

**Write-back 정책** (상위 계층 → 하위 계층)

| 정책 | 동작 | 적합한 시나리오 |
|------|------|---------------|
| `write_through` | 생성 즉시 하위 계층에 기록 | 캐시 유실 방지 |
| `write_through_selective` | 자주 접근되는 데이터만 기록 | 쓰기 대역폭 절약 |
| `write_back` | eviction 시에만 기록 | 쓰기 최소화 |

### 연산-전송 오버랩

HiCache는 레이어 단위로 연산과 데이터 전송을 오버랩합니다.

```
Transformer 레이어 처리:
  Layer N:   [GPU에서 Attention + FFN 연산]
  Layer N+1: [CPU/L3에서 GPU로 KV cache prefetch]
             ↑ Layer N 연산 중에 병렬 수행

→ KV cache 로딩 지연이 연산 시간 뒤에 숨겨짐
```

### 성능 효과

| 지표 | 개선폭 |
|------|--------|
| 처리량 | **최대 6x** 향상 |
| TTFT | **최대 80%** 감소 |
| 캐시 히트율 | 40% → **80%** (3FS 백엔드) |

DeepSeek 3FS KVStore를 L3 백엔드로 사용한 경우, TTFT가 56% 감소하고 처리량이 2배 향상되었습니다.

### 설정 예시

```bash
python -m sglang.launch_server \
    --model-path meta-llama/Llama-3.1-70B-Instruct \
    --tp 8 \
    --enable-hierarchical-cache \
    --hicache-ratio 2.0 \
    --hicache-size 64 \
    --page-size 16 \
    --hicache-storage-prefetch-policy timeout \
    --hicache-write-policy write_through \
    --hicache-io-backend kernel \
    --hicache-mem-layout page_first_direct \
    --hicache-storage-backend mooncake
```

핵심 파라미터 정리입니다.

| 파라미터 | 설명 | 기본값 |
|---------|------|--------|
| `--hicache-ratio` | L2/L1 크기 비율 (반드시 > 1.0) | 2.0 |
| `--hicache-size` | L2 풀 크기 (GB, GPU당) | 자동 |
| `--hicache-io-backend` | `direct` (표준) / `kernel` (GPU 가속, 3x 빠름) | direct |
| `--hicache-mem-layout` | `page_first_direct` (TP 환경 권장) | layer_first |

### 언제 HiCache를 사용하는가

- **긴 컨텍스트 워크로드** (문서 분석, RAG). KV cache가 크기 때문에 GPU만으로 부족합니다.
- **Multi-turn 대화 서비스**. 이전 대화의 KV cache를 CPU에 보관하고 재방문 시 복원합니다.
- **GPU 메모리가 부족한 환경**. 모델 가중치가 GPU 메모리의 대부분을 차지하는 경우입니다.
- 반대로, 작업 집합(working set)이 GPU 메모리에 충분히 들어간다면 일반 RadixCache로 충분합니다.

## Speculative Decoding: 생성 속도 가속

### Decode의 근본적 한계

Decode 단계에서 각 토큰은 모델의 전체 가중치를 메모리에서 읽어야 합니다. 이 **메모리 대역폭 병목**은 하드웨어를 교체하지 않는 한 해소할 수 없습니다.

Speculative Decoding은 이 한계를 우회합니다. **작고 빠른 모델(draft model)이 여러 토큰을 추측하고, 큰 모델(target model)이 한 번의 forward pass로 검증**합니다.

```
일반 Decode (토큰 하나씩):
  Step 1: Target 모델 forward → tok_1
  Step 2: Target 모델 forward → tok_2
  Step 3: Target 모델 forward → tok_3
  Step 4: Target 모델 forward → tok_4
  총: 4회 forward pass

Speculative Decoding:
  Draft:  작은 모델이 빠르게 4개 토큰 추측 → [tok_1', tok_2', tok_3', tok_4']
  Verify: Target 모델이 한 번에 4개 검증 → [tok_1'✓, tok_2'✓, tok_3'✓, tok_4'✗]
  결과:   3개 수락, 1개 거부 후 올바른 tok_4 생성
  총: Draft cost + 1회 Target forward = 3토큰을 ~1회 비용으로 생성
```

### EAGLE 기반 Speculative Decoding

SGLang은 **EAGLE** 알고리즘을 기본으로 사용합니다. EAGLE의 핵심은 "토큰"이 아닌 **"피처(feature)"** 를 예측한다는 점입니다.

```
일반 Speculative Decoding:
  Draft 모델: 독립적인 작은 LLM → 다음 토큰 예측

EAGLE:
  Draft 모델: Target 모델의 중간 피처를 입력으로 받아
              → 다음 피처 벡터를 예측
              → LM Head를 통해 토큰으로 변환

  장점: Target 모델의 내부 표현을 직접 활용 → 더 높은 수락률
```

SGLang은 EAGLE의 두 가지 버전을 지원합니다.

| 버전 | 핵심 개선 | Llama-3.1-8B (H100) |
|------|----------|---------------------|
| **EAGLE-2** | 피처 기반 예측 | 244 tok/s (+54%) |
| **EAGLE-3** | 하위/중간 레이어 피처 활용, On-policy 학습 | **373 tok/s (+135%)** |

### DeepSeek MTP (Multi-Token Prediction)

DeepSeek V3/R1은 학습 시 **MTP(Multi-Token Prediction)** 모듈을 함께 학습합니다. 이 모듈은 별도의 draft 모델 없이, 모델 자체의 NextN 모듈을 draft로 활용합니다.

```
DeepSeek V3 MTP 구조:
  메인 모델:  [...Transformer Blocks...] → LM Head → tok_1 (확정)
                    │
                    ▼
  NextN 모듈: [Embedding] → [Linear] → [Transformer Block] → [Head]
              → tok_2' (추측)
              → tok_3' (추측)
              → tok_4' (추측)

  → Draft 모델 학습/로딩 불필요 (MTP 가중치가 메인 모델에 포함)
```

```bash
# DeepSeek V3에서 MTP 활성화 (기본 설정)
python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3 \
    --tp 8 \
    --speculative-algorithm EAGLE \
    --speculative-num-steps 3 \
    --speculative-eagle-topk 1 \
    --speculative-num-draft-tokens 4
```

### SpecForge와 SpecBundle

모든 모델에 MTP가 내장된 것은 아닙니다. **SpecForge**는 EAGLE-3 draft 모델을 효율적으로 학습하는 프레임워크이고, **SpecBundle**은 사전 학습된 draft 모델을 제공합니다.

| 모델 | 수락 길이 | 속도 향상 |
|------|----------|----------|
| Llama-3.1-8B + EAGLE-3 | 3.8 토큰/step | **4.48x** |
| Qwen3-235B-A22B + SpecForge | - | 9.9x 빠른 학습 |

### 성능 벤치마크

| 환경 | 구성 | 속도 향상 |
|------|------|----------|
| H200 TP8, batch=1 | DeepSeek V3 + MTP | **1.8x** |
| H200 TP8, batch=32 | DeepSeek V3 + MTP | **1.5x** |
| MI300X | DeepSeek V3 + MTP (Random) | 1.25~2.11x |
| MI300X | DeepSeek V3 + MTP (ShareGPT) | 1.36~1.80x |

배치 크기가 커질수록 효과가 줄어드는 것은 자연스럽습니다. 배치가 클수록 GPU 연산 유닛 활용률이 이미 높아서, speculative decoding의 이점이 상대적으로 줄어듭니다.

### Overlap Scheduling과의 통합 (SpecV2)

Speculative Decoding의 draft 단계는 CPU에서 준비할 수 있는 작업이 많습니다. **SpecV2**는 Overlap Scheduling과 통합하여 draft 준비를 GPU 실행과 병렬화합니다.

```bash
SGLANG_ENABLE_SPEC_V2=True python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3 \
    --speculative-algorithm EAGLE \
    --speculative-eagle-topk 1  # SpecV2에서 필수
```

## 멀티 노드 배포

### 기본 구성

```bash
# Node 0 (마스터)
python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3 \
    --tp 16 \
    --nnodes 2 --node-rank 0 \
    --dist-init-addr 192.168.114.10:20000 \
    --host 0.0.0.0 --port 40000

# Node 1
python -m sglang.launch_server \
    --model-path deepseek-ai/DeepSeek-V3 \
    --tp 16 \
    --nnodes 2 --node-rank 1 \
    --dist-init-addr 192.168.114.10:20000
```

### 네트워크 요구사항

병렬화 전략에 따라 네트워크 요구사항이 다릅니다.

| 전략 | 통신 패턴 | 네트워크 요구 |
|------|----------|-------------|
| **TP** | All-Reduce (매 레이어) | InfiniBand/RoCE 필수 (고대역폭, 저지연) |
| **PP** | Point-to-Point (레이어 경계) | 높은 지연 허용 |
| **EP** | All-to-All (MoE 레이어) | Full-mesh 토폴로지, RDMA 권장 |
| **DP** | 독립 실행 | 제약 없음 |

### 최신 하드웨어 벤치마크

LMSYS 블로그에서 공개한 GB200 NVL72 결과입니다.

| 지표 | H100 대비 |
|------|----------|
| Prefill 처리량 | **3.8x** |
| Decode 처리량 | **4.8x** |
| Decode per GPU | 13,386 output tok/s/GPU |

FP8 Attention + NVFP4 MoE 조합으로, GPU당 26,156 입력 토큰/초, 13,386 출력 토큰/초를 달성했습니다.

## 기술들의 결합

이 글에서 다룬 네 가지 기술은 독립적이 아니라 **상호 보완적으로 결합**됩니다.

```
프로덕션 DeepSeek V3 배포:

┌─────────────────────────────────────────────┐
│  SGLang Model Gateway (Router)              │
│  Cache-Aware Routing + PD Disaggregation    │
└──────────────┬──────────────────────────────┘
               │
   ┌───────────┴───────────┐
   ▼                       ▼
┌──────────────┐    ┌──────────────┐
│ Prefill Pool │    │ Decode Pool  │  ← PD Disaggregation
│              │    │              │
│ EP + TP      │    │ EP + TP      │  ← Expert Parallelism
│ (DeepEP)     │    │ (DeepEP)     │
│              │    │              │
│ HiCache      │    │ HiCache      │  ← 계층형 KV 캐싱
│ (GPU→CPU→L3) │    │ (GPU→CPU→L3) │
│              │    │              │
│              │    │ Speculative  │  ← Decode 가속
│              │    │ Decoding     │
│              │    │ (MTP)        │
└──────────────┘    └──────────────┘
```

각 기술이 최적화하는 지표가 다르기 때문입니다.

| 기술 | 최적화 대상 |
|------|-----------|
| **Expert Parallelism** | 대형 MoE 모델의 분산 적재와 처리량 |
| **PD Disaggregation** | TTFT/TPOT 분리 최적화, 독립적 스케일링 |
| **HiCache** | 캐시 히트율 극대화, GPU 메모리 한계 극복 |
| **Speculative Decoding** | Decode 단계의 토큰 생성 속도 |

## 마무리

이 글에서는 SGLang을 대규모 GPU 클러스터에서 운영하기 위한 네 가지 핵심 기술을 분석했습니다.

- **Expert Parallelism**은 MoE 모델의 전문가를 GPU 간에 분배하고, DeepEP와 EPLB로 통신과 부하를 최적화합니다.
- **PD Disaggregation**은 Prefill과 Decode를 물리적으로 분리하여 상호 간섭을 제거하고 독립적 스케일링을 가능하게 합니다.
- **HiCache**는 KV cache를 GPU → CPU → 분산 스토리지로 확장하여, 최대 6x 처리량 향상과 80% TTFT 감소를 달성합니다.
- **Speculative Decoding**은 draft 모델의 추측 + target 모델의 검증으로 Decode 속도를 최대 2x 향상시킵니다.

이 기술들은 개별적으로도 강력하지만, 결합할 때 진정한 프로덕션 수준의 성능을 달성합니다. 96대의 H100에서 DeepSeek V3를 노드당 52.3k 입력 토큰/초로 서빙한 사례가 이를 증명합니다.

다음 **Part 5** (시리즈 마지막)에서는 SGLang과 vLLM의 **종합 벤치마크 비교**와 **시나리오별 선택 가이드**를 다루겠습니다. 프레임워크 선택의 의사결정 기준부터 Kubernetes 배포, 모니터링, 장애 대응까지 프로덕션 운영 관점에서 정리합니다.

## 참고 자료

- LMSYS. (2025). *Deploying DeepSeek with PD Disaggregation and Large-Scale EP on 96 H100 GPUs*. [LMSYS Blog](https://lmsys.org/blog/2025-05-05-large-scale-ep/)
- LMSYS. (2025). *SGLang HiCache: Fast Hierarchical KV Caching*. [LMSYS Blog](https://lmsys.org/blog/2025-09-10-sglang-hicache/)
- LMSYS. (2025). *Accelerating SGLang with Multiple Token Prediction*. [LMSYS Blog](https://lmsys.org/blog/2025-07-17-mtp/)
- LMSYS. (2025). *SpecForge: Accelerated Speculative Decoding Training*. [LMSYS Blog](https://lmsys.org/blog/2025-07-25-spec-forge/)
- LMSYS. (2026). *Pipeline Parallelism in SGLang*. [LMSYS Blog](https://lmsys.org/blog/2026-01-15-chunked-pipeline/)
- LMSYS. (2025). *Unlocking GB200 NVL72 Inference Performance Part I*. [LMSYS Blog](https://lmsys.org/blog/2025-06-16-gb200-part-1/)
- LMSYS. (2025). *GB200 NVL72 Part II: NVFP4 MoE*. [LMSYS Blog](https://lmsys.org/blog/2025-09-25-gb200-part-2/)
- SGLang Documentation. *Expert Parallelism*. [docs.sglang.io](https://docs.sglang.io/advanced_features/expert_parallelism.html)
- SGLang Documentation. *PD Disaggregation*. [docs.sglang.io](https://docs.sglang.io/advanced_features/pd_disaggregation.html)
- SGLang Documentation. *HiCache System Design*. [docs.sglang.io](https://docs.sglang.io/advanced_features/hicache_design.html)
- SGLang Documentation. *Speculative Decoding*. [docs.sglang.io](https://docs.sglang.io/advanced_features/speculative_decoding.html)
- SGLang Documentation. *DeepSeek V3 Usage*. [docs.sglang.io](https://docs.sglang.io/basic_usage/deepseek_v3.html)
- DeepSeek. *EPLB (Expert Parallelism Load Balancer)*. [GitHub](https://github.com/deepseek-ai/EPLB)
- AMD ROCm. *MTP on MI300X with SGLang*. [ROCm Blog](https://rocm.blogs.amd.com/software-tools-optimization/mtp/README.html)
