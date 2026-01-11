---
layout: single
title: "LLM 추론의 Memory-Bound 특성과 배치 최적화"
date: 2025-01-11 00:00:00 +0000
categories: [ai, infrastructure]
tags: [llm, vllm, gpu, inference, memory-bandwidth, prefill, decode, batch, optimization]
excerpt: "LLM 추론이 왜 Memory-Bound인지, Prefill과 Decode 단계의 차이점, 그리고 Batch Size가 처리량에 미치는 영향을 RTX 5070 Ti 벤치마크 결과와 함께 살펴봅니다."
---

## 들어가며

LLM(Large Language Model)을 프로덕션에 배포할 때 가장 먼저 부딪히는 문제는 **처리량(Throughput)**과 **지연시간(Latency)**입니다. GPU가 비싸기 때문에 하나의 GPU에서 최대한 많은 요청을 처리하고 싶지만, 동시에 사용자 경험을 위해 응답 속도도 빨라야 합니다.

이 글에서는 LLM 추론의 핵심 특성인 **Memory-Bound** 현상을 이해하고, Prefill과 Decode 단계의 차이점, 그리고 Batch Size가 처리량에 미치는 영향을 RTX 5070 Ti에서 직접 측정한 벤치마크 결과와 함께 살펴보겠습니다.

## LLM 추론은 왜 Memory-Bound인가?

### Compute-Bound vs Memory-Bound

GPU 워크로드에서 Compute-Bound, Memory-Bound 작업은 아래와 같이 구분할 수 있습니다.

| 특성 | Compute-Bound | Memory-Bound |
|------|--------------|--------------|
| 병목 | GPU 연산 능력 (FLOPS) | 메모리 대역폭 (GB/s) |
| 특징 | 연산량이 많음 | 데이터 이동이 많음 |
| 예시 | 대규모 행렬 연산, 학습 | LLM Decode, 작은 배치 추론 |

이 중에서 주요 병목이 되는 것은 LLM 추론에서 **Decode 단계에서의 Memory-Bound**입니다. 토큰 하나를 생성할 때마다 모델 전체 가중치를 GPU 메모리에서 읽어야 하기 때문입니다.

### Llama 70B on H100

단적인 예로 Llama 3.1 70B 모델(BF16)을 H100 GPU에서 실행하는 경우를 살펴보겠습니다:
```
모델 크기: 70B × 2 bytes (BF16) = 140GB
H100 메모리 대역폭: 3.35 TB/s

토큰 1개 생성 시:
- 메모리 읽기 시간: 140GB / 3,350GB/s ≈ 42ms
- 실제 연산 시간: 140B FLOPs / 989 TFLOPS ≈ 0.14ms

병목 비율: 메모리 읽기가 연산보다 300배 느림
결과: GPU 코어의 95%가 메모리를 기다리며 유휴 상태
```

이는 GPU가 아무리 빠른 연산 능력을 가지고 있어도, 메모리에서 데이터를 읽어오는 속도가 따라주지 못하면 성능이 나오지 않음을 보여줍니다.


### 토큰 생성 과정

Transformer 모델에서 토큰 1개를 생성하는 과정을 살펴보면 아래와 같습니다.

```
입력: 이전 토큰의 hidden state [1 × hidden_size]

Layer 1:
  - Q, K, V projection: [hidden × hidden] × 3 → 가중치 읽기
  - Attention 연산
  - FFN: [hidden × 4×hidden] + [4×hidden × hidden] → 가중치 읽기

Layer 2 ~ Layer N: (동일 과정 반복)

Output projection: [hidden × vocab_size] → 가중치 읽기

→ 모든 레이어의 모든 가중치를 순차적으로 읽어야 함
```

예를 들어 3B 파라미터 모델(FP16)의 경우:

```
파라미터 수: 3B = 3,000,000,000개
FP16 크기: 3B × 2 bytes = 6GB

토큰 1개 생성 = 6GB 메모리 읽기 + 상대적으로 작은 연산량
```

### Arithmetic Intensity

**Arithmetic Intensity**(연산 강도)는 메모리 전송량 대비 연산량을 나타내는 지표입니다:

```
AI = FLOPs / Bytes Transferred

Decode 단계: AI ≈ 1-2 (매우 낮음 → memory-bound)
Prefill 단계: AI ≈ 수십~수백 (높음 → compute-bound)
```

Decode 단계에서는 같은 양의 가중치를 읽지만 연산이 매우 작습니다. 100개 토큰에 대해 행렬 연산을 수행하는 것과 1개 토큰에 대해 벡터 연산을 수행하는 것의 차이입니다.

## Prefill vs Decode 단계

LLM 추론은 두 가지 단계로 나뉩니다:

### Prefill 단계

- **목적**: 입력 프롬프트 전체를 한 번에 처리
- **특성**: Compute-Bound
- **연산**: 행렬 × 행렬 (대규모 병렬 연산)

```
입력: "마이크로서비스 아키텍처에 대해 설명해주세요" (100 토큰)

처리: [100 × hidden] × [hidden × hidden] = 대규모 행렬 연산
출력: KV Cache 생성 (K, V 벡터 저장)
```

### Decode 단계

- **목적**: 토큰을 하나씩 순차적으로 생성
- **특성**: Memory-Bound
- **연산**: 벡터 × 행렬 (연산량 작음)

```
입력: 이전에 생성된 토큰 1개

처리: [1 × hidden] × [hidden × hidden] = 벡터-행렬 연산
출력: 다음 토큰 1개 생성
```

### 벤치마크 결과 (RTX 5070 Ti + Qwen 3B)

| 프롬프트 토큰 | TTFT (Prefill) | Decode 시간 | Prefill 처리량 | Decode 처리량 |
|------------|----------------|-------------|---------------|--------------|
| 168 | 0.068s | 3.53s | 2,461 t/s | 24.9 t/s |
| 823 | 0.058s | 3.36s | 14,071 t/s | 26.6 t/s |
| 3,312 | 0.067s | 3.36s | 49,109 t/s | 27.1 t/s |

핵심 발견:

1. **TTFT(Time To First Token)**가 프롬프트 길이와 거의 무관하게 ~0.06초로 일정
2. Prefill 처리량: 2,461 → 49,109 t/s (20배 증가)
3. Decode 처리량: ~27 t/s로 일정

RTX 5070 Ti의 연산 능력이 3B 모델에 충분히 여유 있어서 Prefill은 빠르게 처리됩니다. 하지만 Decode는 메모리 대역폭에 의해 제한되어 일정한 속도를 보입니다.

## Batch Size의 영향

### 가중치 로딩 공유

배치 처리의 핵심은 **가중치 로딩을 여러 요청이 공유**한다는 점입니다:

```
Batch=1:  가중치 6GB 1번 읽기 → 1개 토큰 생성 (비효율)
Batch=32: 가중치 6GB 1번 읽기 → 32개 토큰 동시 생성 (32배 효율!)
```

### 벤치마크 결과 (RTX 5070 Ti + Qwen 3B FP16)

| Batch Size | 처리량 (t/s) | 추정 BW 활용률 | 배치 효율 |
|------------|--------------|---------------|----------|
| 1 | 21.0 | 25% | 기준 |
| 2 | 43.2 | 51% | 2.1x |
| 4 | 90.0 | 107% | 4.3x |
| 8 | 182.8 | 218% | 8.7x |
| 16 | 383.6 | 457% | 18.3x |
| 32 | 701.6 | 835% | 33.4x |

```
처리량 증가 곡선:

       ↑ 처리량 (tokens/sec)
   800 ┤                            ●  (Batch 32: 702)
       │                        ●
   600 ┤
       │
   400 ┤                ●  (Batch 16: 384)
       │
   200 ┤        ●  (Batch 8: 183)
       │    ●  (Batch 4: 90)
   100 ┤●  ●
       │1  2
       └──────────────────────────────→ Batch Size
```

### 활용률이 100%를 초과하는 이유

단순 추정 모델 `throughput × model_size`는 "토큰당 전체 가중치를 읽는다"고 가정하지만, 실제로는:

1. **GPU L2 캐시 효과**: 48MB L2 캐시에 자주 접근하는 가중치 유지
2. **배치 연산 효율**: 큰 배치 → 행렬 연산으로 묶임 → Tensor Core 활용 증가
3. **가중치 재사용**: 배치 내 여러 요청이 동일 가중치 공유

### Memory-Bound → Compute-Bound 전환점

배치 크기에 따른 처리량 증가율을 보면 전환점을 파악할 수 있습니다:

```
Batch 1→2:   21 → 43 t/s  (+105%)  ← 거의 2배 = Memory-bound
Batch 2→4:   43 → 90 t/s  (+109%)  ← 거의 2배 = Memory-bound
Batch 4→8:   90 → 183 t/s (+103%)  ← 전환점
Batch 16→32: 384 → 702 t/s (+83%)  ← 2배 미만 = Compute-bound로 전환
```

| 특성 | Memory-Bound | Compute-Bound |
|------|--------------|---------------|
| 활용률 | 100% 미만 | 100% 초과 |
| 배치 2배 시 | 처리량 ~2배 | 처리량 < 2배 |

## 실무적 의미

### vLLM의 Continuous Batching

vLLM은 **Continuous Batching**을 통해 동적으로 배치 크기를 관리합니다:

```
시간 →
Req1: ████████ (완료)
Req2: ████████████████ (완료)
Req3: ████████████ (완료)
Req4:     ████████████████ (Req1 완료 후 즉시 추가)
Req5:         ████████████ (Req3 완료 후 즉시 추가)

→ 요청이 불규칙하게 들어와도 항상 최대한의 배치 크기 유지
→ Memory bandwidth 효율 극대화
```

### 이론적 최대 처리량

```
RTX 5070 Ti 메모리 대역폭: ~504 GB/s
Qwen2.5-3B 모델 크기: ~6GB (FP16)

단일 요청 이론 최대: 504 / 6 = 84 tokens/s
실제 측정 (Batch=1): 21 tokens/s (25% 활용)
→ 캐시 미스, 오버헤드 등으로 실제 효율 저하
```

메모리 대역폭이 높은 GPU일수록 Decode 성능이 향상됩니다:

```
RTX 5070 Ti (504 GB/s)  → ~27 t/s
A100 (2,039 GB/s)       → ~100+ t/s
H100 (3,350 GB/s)       → ~150+ t/s
```

## 결론

LLM 추론에서 **Decode 단계는 Memory-Bound**이며, 이는 토큰 하나를 생성할 때마다 모델 전체 가중치를 메모리에서 읽어야 하기 때문입니다. 이 특성을 이해하면 왜 배칭이 중요한지, 왜 양자화가 성능을 향상시키는지 명확해집니다.

핵심 인사이트

1. **Prefill은 Compute-bound, Decode는 Memory-bound**: 같은 GPU라도 단계에 따라 병목이 다름
2. **Batch Size 증가 = 처리량 증가**: 가중치 로딩을 공유하여 메모리 대역폭 효율 향상
3. **vLLM의 Continuous Batching**: 동적 배칭으로 항상 최대 효율 유지


## Reference

- [vLLM: Easy, Fast, and Cheap LLM Serving](https://docs.vllm.ai/en/latest/)
- [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180)
- [NVIDIA GPU Architecture](https://developer.nvidia.com/cuda-gpus)
