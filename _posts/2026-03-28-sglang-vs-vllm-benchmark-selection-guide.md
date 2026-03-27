---
layout: single
title: "[작성중] SGLang vs vLLM 종합 벤치마크 및 선택 가이드 (SGLang 시리즈 Part 5)"
date: 2026-03-28 14:00:00 +0900
categories: mlops
tags: [sglang, vllm, benchmark, llm-serving, inference, comparison, h100, deepseek, production]
excerpt: "SGLang과 vLLM, 어떤 상황에서 어떤 엔진을 선택해야 할까요? H100/H200/MI300X에서의 실측 벤치마크, 모델별 성능 비교, 워크로드 유형별 분석, 그리고 프로덕션 운영 관점에서의 차이를 종합적으로 정리합니다."
---

> 이 글은 **SGLang v0.5.9** (2026년 2월)과 **vLLM v0.17.1** (2026년 3월) 기준으로 작성되었습니다.
>
> **이 글은 작성 중입니다.** 자체 벤치마크 결과가 추가될 예정입니다.

## 들어가며

[Part 1]({{ site.baseurl }}{% post_url 2026-03-26-sglang-architecture-deep-dive %})부터 [Part 4]({{ site.baseurl }}{% post_url 2026-03-28-sglang-large-scale-gpu-cluster-operations %})까지 SGLang의 아키텍처, RadixAttention, Compressed FSM, 대규모 GPU 운영을 분석했습니다. 이제 실전의 핵심 질문에 답할 차례입니다.

**"우리 서비스에는 SGLang과 vLLM 중 무엇이 적합한가?"**

이 질문에 "항상 X가 좋다"라는 답은 없습니다. 모델, 하드웨어, 워크로드 유형, 동시 접속 수에 따라 답이 달라집니다. 이 글에서는 공개된 벤치마크 데이터를 종합하고, 시리즈에서 분석한 아키텍처 차이가 실제 성능에 어떻게 반영되는지를 연결하여 정리합니다.

## 벤치마크를 보기 전에: 주목해야 할 포인트

시리즈에서 분석한 아키텍처 차이를 기반으로, 벤치마크에서 **어디를 봐야 하는지** 먼저 정리하겠습니다.

### 1. Prefix 재활용 시나리오에서의 처리량 차이

[Part 2]({{ site.baseurl }}{% post_url 2026-03-27-sglang-radixattention-vs-pagedattention %})에서 분석한 **RadixAttention vs PagedAttention**의 차이가 가장 크게 드러나는 지점입니다.

```
주목할 벤치마크 패턴:
  "캐시 미사용 시" vs "캐시 활용 시" 처리량 비교
  → 차이가 클수록 RadixAttention의 이점이 큼

  "Few-shot" 벤치마크에서의 절대 성능
  → SGLang의 cache-aware scheduling(DFS_WEIGHT)이 효과를 발휘하는 시나리오

  "Multi-turn" 시나리오에서의 p99 레이턴시
  → Tree 구조의 누적 캐시 재활용 vs Hash 기반 APC의 차이
```

### 2. 구조화 출력에서의 동시성별 성능 변화

[Part 3]({{ site.baseurl }}{% post_url 2026-03-27-sglang-compressed-fsm-structured-output %})에서 분석한 **Compressed FSM + Overlap Scheduling**의 차이가 드러나는 지점입니다.

```
주목할 벤치마크 패턴:
  동시성(concurrency) 증가에 따른 구조화 출력 성능 변화
  → vLLM: 배치 ≥ 8에서 급격한 성능 하락 (순차적 마스크 생성)
  → SGLang: GPU 실행과 마스크 생성 오버랩으로 안정적

  비제약 생성 대비 구조화 출력의 오버헤드 비율
  → Compressed FSM의 jump-forward가 오버헤드를 얼마나 상쇄하는지
```

### 3. 대규모 MoE 모델에서의 스케일링 효율

[Part 4]({{ site.baseurl }}{% post_url 2026-03-28-sglang-large-scale-gpu-cluster-operations %})에서 분석한 **EP, PD Disaggregation, HiCache**의 차이가 드러나는 지점입니다.

```
주목할 벤치마크 패턴:
  DeepSeek V3(671B MoE) 같은 모델에서 GPU 수 증가에 따른 스케일링
  → EP + DP 조합의 효율성

  Prefill과 Decode 분리 시의 TTFT/TPOT 변화
  → PD Disaggregation의 실제 효과

  GPU 메모리를 넘어서는 KV cache 워크로드에서의 성능
  → HiCache의 실전 효과
```

### 4. 하드웨어별 최적화 차이

```
주목할 벤치마크 패턴:
  같은 모델, 다른 GPU (H100 vs H200 vs MI300X)에서의 상대적 성능
  → SGLang은 FlashInfer 기본, vLLM은 FlashAttention 기본
  → AMD GPU에서의 호환성 차이

  cold start 시간과 warm-up 효과
  → 프로덕션 스케일링에서 중요한 운영 지표
```

## 공개 벤치마크 종합

### 처리량(Throughput) 비교

여러 출처의 벤치마크를 모델과 GPU별로 정리했습니다.

#### 소형 모델 (8B 급)

| 모델 | GPU | SGLang | vLLM | 차이 | 출처 |
|------|-----|--------|------|------|------|
| Llama 3.1 8B | H100 | **16,215 tok/s** | 12,553 tok/s | SGLang +29% | PremAI |
| Qwen3.5-0.8B (16 동시) | 단일 GPU | **2.47초** (전체) | 11.26초 | SGLang **4.6x** | DEV Community |
| Qwen3-8B | L40 | **54.2초** (전체) | 58.9초 | SGLang +9% | ersteiger |

소형 모델에서 SGLang의 이점이 뚜렷합니다. 특히 동시 요청 처리에서 4.6배 차이가 나는 것은 Overlap Scheduling과 효율적인 배치 구성의 효과입니다.

#### 중형 모델 (70B 급)

| 모델 | GPU | SGLang | vLLM | 차이 | 출처 |
|------|-----|--------|------|------|------|
| Llama 3.3 70B FP8 @100c | H100 | 2,460 tok/s | 2,400 tok/s | 거의 동등 | Spheron |
| Llama 3.1 70B FP8 TTFT | 1xH100 | 340ms | **123ms** | vLLM 유리 | Cerebrium |
| Llama 3.1 70B FP8 @batch64 | 1xH100 | **460 tok/s** | - | SGLang 최고 | Cerebrium |
| Llama 70B (A100) | A100 | **3.1x** | 기준 | SGLang 압도적 | LMSYS |

70B 모델에서는 시나리오에 따라 결과가 갈립니다. **배치 처리량**은 SGLang이 우세하지만, **단일 요청의 TTFT**는 vLLM이 빠른 경우가 있습니다.

#### 대형 모델 (120B+, MoE)

| 모델 | GPU | SGLang | vLLM | 차이 | 출처 |
|------|-----|--------|------|------|------|
| GPT-OSS-120B @50c | 2xH100 | **3,109 tok/s** | 2,212 tok/s | SGLang +41% | Clarifai |
| GPT-OSS-120B @100c | 2xH100 | 3,222 tok/s | **4,742 tok/s** | vLLM +47% | Clarifai |
| DeepSeek R1 (offline) | 8xH200 | **6,311 tok/s** | - | SGLang 최고 | dstack |
| DeepSeek R1 (online, <128c) | 8xH200 | - | vLLM 우세 | - | dstack |
| DeepSeek R1 | 8xMI300X | - | **4,574 tok/s** | vLLM 우세 | dstack |

흥미로운 패턴이 보입니다. **중간 동시성(~50)에서 SGLang이 강하고, 극단적 동시성(100+)에서 vLLM이 강해지는 경향**입니다. 또한 **AMD MI300X에서는 vLLM이 우세**합니다.

### 레이턴시(Latency) 비교

#### TTFT (Time To First Token)

| 모델 | GPU | 동시성 | SGLang | vLLM | 출처 |
|------|-----|--------|--------|------|------|
| Llama 3.3 70B FP8 | H100 | 1 | **42ms** | 45ms | Spheron |
| Llama 3.3 70B FP8 | H100 | 50 | **360ms** | 380ms | Spheron |
| Llama 3.3 70B FP8 | H100 | 100 | **710ms** | 740ms | Spheron |
| Qwen3-8B p99 | L40 | - | **17.1ms** | 23.6ms | ersteiger |

**p50(중앙값)**에서는 두 엔진이 비슷하지만, **p99(꼬리 레이턴시)에서 vLLM이 80% 더 높은** 경우가 있습니다. 이는 SLA가 중요한 프로덕션 환경에서 유의미한 차이입니다.

#### Per-Token Latency (TPOT / ITL)

| 모델 | GPU | 동시성 | SGLang | vLLM | 출처 |
|------|-----|--------|--------|------|------|
| GPT-OSS-120B | 2xH100 | 1 | **4ms** | 5ms | Clarifai |
| GPT-OSS-120B | 2xH100 | 50 | **15ms** | 21ms | Clarifai |
| DeepSeek-R1-Qwen-1.5B | 2xL40 | - | **6.0ms** | 7.1ms | Medium |

SGLang의 per-token 레이턴시가 전반적으로 더 안정적입니다. **4~21ms 범위** 내에서 일관된 성능을 보이는 반면, vLLM은 변동폭이 더 큽니다. 이는 Overlap Scheduling의 효과입니다.

### Prefix Caching 효과 비교

[Part 2]({{ site.baseurl }}{% post_url 2026-03-27-sglang-radixattention-vs-pagedattention %})의 분석이 실제 벤치마크에서 어떻게 나타나는지 확인합니다.

#### 캐시 히트율

| 워크로드 | SGLang (RadixAttention) | vLLM (APC) | 출처 |
|---------|------------------------|------------|------|
| Few-shot Learning | **85~95%** | 15~25% | PremAI |
| Multi-turn Chat | **75~90%** | 10~20% | PremAI |
| Code Analysis | **60~80%** | 5~15% | PremAI |

RadixAttention의 tree 기반 자동 prefix 발견과 cache-aware scheduling(DFS_WEIGHT)이 캐시 히트율에서 **3~6배 차이**를 만들어냅니다.

#### 캐시 활용 시 성능 (H100, DeepSeek-R1-Distill-Llama-70B)

| 시나리오 | SGLang | vLLM | 출처 |
|---------|--------|------|------|
| 7K context, 캐시 미사용 | 29.5 tok/s | 28.6 tok/s | RunPod |
| 7K context, 캐시 활용 | **35.0 tok/s** | 32.8 tok/s | RunPod |
| 캐시로 인한 개선폭 | **+19%** | +15% | RunPod |
| 단일 요청 (캐시 없음) | 52.7 tok/s | **60.0 tok/s** | RunPod |

캐시 미사용 단일 요청에서는 vLLM이 빠르지만, 캐시를 활용하면 SGLang이 역전합니다. **prefix sharing이 빈번한 워크로드일수록 SGLang의 이점이 극대화**됩니다.

#### Few-shot 벤치마크 (A10G)

| 워크로드 | SGLang | vLLM | 차이 | 출처 |
|---------|--------|------|------|------|
| MMLU (5-shot) | **4,250 tok/s** | 1,420 tok/s | **3.0x** | LMSYS |
| Few-shot 일반 | **2,850 tok/s** | 650 tok/s | **4.4x** | LMSYS |

Few-shot 시나리오에서 3~4.4배의 처리량 차이는 Part 2에서 분석한 RadixAttention의 구조적 이점을 그대로 반영합니다. 동일한 few-shot 예시의 KV cache를 tree 구조로 자동 공유하고, DFS_WEIGHT 스케줄링으로 캐시 히트를 극대화한 결과입니다.

### 구조화 출력(Structured Output) 성능 비교

[Part 3]({{ site.baseurl }}{% post_url 2026-03-27-sglang-compressed-fsm-structured-output %})의 분석이 실제로 어떻게 나타나는지 확인합니다.

| 지표 | SGLang | vLLM | 출처 |
|------|--------|------|------|
| JSON 디코딩 속도 | **최대 10x 빠름** | 기준 | LMSYS v0.4 |
| 동시성 8+ 에서의 오버헤드 | 최소 | **급격한 성능 하락** | SqueezeBits |
| 비제약 생성 대비 정확도 | **96~100%** | **96~100%** | SqueezeBits |
| 비제약 생성 정확도 | ≤72% | ≤72% | SqueezeBits |

핵심 차이는 **동시성이 높아질 때** 드러납니다. vLLM은 문법 마스크 생성이 critical path에 있어 배치 내 하나의 요청이라도 구조화 출력을 사용하면 전체가 대기합니다. SGLang은 Overlap Scheduling으로 마스크 생성을 GPU 실행과 병렬화하여 오버헤드를 흡수합니다.

### 하드웨어별 승자

| 하드웨어 | 배치/오프라인 | 온라인 서빙 | 비고 |
|---------|-------------|-----------|------|
| **H100** | SGLang (+29%) | 비슷~SGLang | FlashInfer 최적화 |
| **A100** | SGLang (최대 3.1x) | SGLang | LMSYS 공식 벤치마크 |
| **H200** | SGLang (6,311 tok/s) | vLLM (<128c) | 시나리오에 따라 다름 |
| **MI300X** | vLLM | **vLLM** | AMD에서 vLLM 명확히 우세 |
| **L40** | SGLang (4.6x 동시성) | SGLang | 소형 모델 동시 서빙 |

**AMD MI300X에서 vLLM이 우세**한 것은 주목할 점입니다. SGLang의 FlashInfer가 NVIDIA CUDA에 최적화되어 있는 반면, vLLM은 ROCm 지원이 더 성숙합니다.

## 운영 관점 비교

### Kubernetes 배포

| 항목 | vLLM | SGLang |
|------|------|--------|
| **공식 Helm Chart** | 있음 (production-stack) | 제한적 (GPUStack 또는 커스텀) |
| **HPA (Auto-scaling)** | KEDA 연동 지원 | 커스텀 구현 필요 |
| **Health Probes** | startup/readiness/liveness | readiness/liveness |
| **클라우드 프로바이더 지원** | 광범위 (GCP, AWS, Azure) | 증가 중 (Oracle, Azure) |

vLLM의 Kubernetes 생태계가 더 성숙합니다. SGLang을 프로덕션 K8s에 배포하려면 추가적인 인프라 구성(cache-aware router, PD disaggregation router 등)이 필요합니다.

### 모니터링 (Prometheus 메트릭)

| 항목 | vLLM | SGLang |
|------|------|--------|
| **메트릭 Prefix** | `vllm:` | `sglang_` (v0.5.4+) |
| **활성화** | 기본 활성 | `--enable-metrics` 플래그 필요 |
| **주요 메트릭** | `num_requests_running`, `kv_cache_usage_perc`, latency histograms | phase labels (prefill/decode), 라우터 40+ 메트릭 |
| **Grafana 대시보드** | 공식 제공 | 커뮤니티 |

두 엔진 모두 Prometheus + Grafana 통합을 지원합니다. vLLM이 기본 활성이라 초기 설정이 간단하고, SGLang은 라우터 레벨에서 더 세밀한 메트릭을 제공합니다.

### Cold Start와 Warm-up

| 항목 | vLLM | SGLang |
|------|------|--------|
| **Cold Start** | ~62초 | ~58초 |
| **Warm-up 필요** | 불필요 (첫 요청부터 일관) | **필요** (초기 요청에서 최적 성능 아님) |
| **torch.compile** | piecewise 컴파일 (기본) | 전체 컴파일 (더 느린 시작) |

SGLang의 **warm-up 효과**는 운영 시 고려해야 할 점입니다. RadixAttention의 캐시가 쌓이기 전에는 캐시 히트가 없으므로 초기 성능이 낮을 수 있습니다. Rolling update 시 새 Pod로의 트래픽 전환 타이밍에 영향을 줍니다.

### 모델 지원 범위

두 엔진 모두 주요 모델 패밀리(Llama, Qwen, DeepSeek, Gemma, Mistral)를 지원합니다. 차이점은 다음과 같습니다.

| 영역 | vLLM | SGLang |
|------|------|--------|
| **OpenAI 호환 API** | 가장 광범위 | 거의 동등 |
| **Multi-LoRA** | 성숙 | 지원 (S-LoRA 기반) |
| **Diffusion 모델** | 미지원 | **지원** (Wan, Hunyuan, Flux 등) |
| **Reasoning 모델** | 지원 | **더 깊은 통합** (reasoning-parser) |
| **MoE 최적화** | 지원 | **더 깊은 최적화** (DeepEP, EPLB) |

## 시나리오별 선택 가이드

벤치마크와 아키텍처 분석을 종합하여, 워크로드별 추천을 정리합니다.

### SGLang을 선택해야 하는 경우

**1. Few-shot / RAG 파이프라인** (3~4.4x 처리량 향상)
- 동일한 system prompt나 few-shot 예시를 공유하는 대량 요청
- RadixAttention의 자동 prefix 재활용 + DFS_WEIGHT 스케줄링이 핵심
- 캐시 히트율: 85~95% vs vLLM의 15~25%

**2. Multi-turn 대화 서비스** (10~20% 처리량 향상)
- 이전 턴의 KV cache를 tree 구조로 누적 재활용
- p99 레이턴시에서 유의미한 차이 (vLLM 대비 80% 낮은 p99)

**3. JSON/구조화 출력이 많은 서비스** (최대 10x 빠른 JSON)
- Compressed FSM의 jump-forward로 결정론적 토큰 구간 건너뜀
- 동시성 8 이상에서 vLLM 대비 안정적 성능 유지

**4. 배치/오프라인 처리** (H100에서 +29%)
- 대량의 요청을 비동기로 처리하는 파이프라인
- Overlap Scheduling으로 GPU 유휴 시간 제거

**5. DeepSeek V3/R1 대규모 서빙**
- EP + PD Disaggregation + MTP의 조합
- 96 H100에서 노드당 52.3k input tok/s 달성

### vLLM을 선택해야 하는 경우

**1. 극단적 동시성 (100+ 동시 요청)** (GPT-OSS-120B에서 +47%)
- 매우 높은 동시 접속에서 vLLM의 스케줄러가 안정적

**2. AMD GPU (MI300X)** (vLLM 명확히 우세)
- ROCm 지원이 더 성숙
- FlashInfer의 NVIDIA 의존성 없음

**3. 기존 K8s 인프라와의 통합**
- 공식 Helm chart, KEDA HPA, production-stack
- 클라우드 프로바이더 네이티브 지원

**4. 단일 요청 위주 + 낮은 동시성**
- prefix sharing이 거의 없는 독립적 요청
- warm-up 없이 첫 요청부터 일관된 성능

**5. 빠른 프로토타이핑과 개발**
- 더 넓은 커뮤니티, 더 많은 튜토리얼과 문서
- OpenAI 호환 API의 가장 높은 호환성

### 판단 플로우차트

```
시작
  │
  ├─ AMD GPU (MI300X) 사용? ─── Yes ──→ vLLM
  │
  ├─ prefix 공유가 빈번한 워크로드?
  │    (few-shot, multi-turn, RAG, 공통 system prompt)
  │    ├─ Yes ──→ SGLang (RadixAttention 이점 극대화)
  │    └─ No  ──→ 다음 질문
  │
  ├─ 구조화 출력(JSON)이 핵심?
  │    ├─ Yes + 동시성 높음 ──→ SGLang (Overlap + Compressed FSM)
  │    └─ Yes + 동시성 낮음 ──→ 두 엔진 모두 적합
  │
  ├─ DeepSeek V3/R1 같은 대형 MoE?
  │    ├─ Yes ──→ SGLang (EP + PD Disaggregation + MTP)
  │    └─ No  ──→ 다음 질문
  │
  ├─ 동시 접속 100+ 이고 prefix 공유 없음?
  │    ├─ Yes ──→ vLLM
  │    └─ No  ──→ 다음 질문
  │
  ├─ K8s 운영 성숙도가 중요?
  │    ├─ Yes ──→ vLLM (더 나은 K8s 생태계)
  │    └─ No  ──→ SGLang (더 높은 처리량)
  │
  └─ 기본 선택: SGLang (대부분의 시나리오에서 우세하거나 동등)
```

## 자체 벤치마크 (추가 예정)

> 이 섹션은 자체 벤치마크 결과로 업데이트될 예정입니다.
> 테스트 환경, 모델, 워크로드 구성과 실측 결과가 추가됩니다.

<!--
추가 예정 항목:
- 테스트 환경 (GPU, 모델, 데이터셋)
- 처리량 비교 (동시성별)
- 레이턴시 비교 (TTFT, TPOT, p50/p95/p99)
- Prefix caching 효과 비교
- 구조화 출력 성능 비교
- 메모리 사용량 비교
-->

## 마무리

### 시리즈 총정리

5편에 걸쳐 SGLang을 분석한 핵심을 한 문장씩 정리합니다.

| Part | 핵심 |
|------|------|
| [Part 1: 아키텍처]({{ site.baseurl }}{% post_url 2026-03-26-sglang-architecture-deep-dive %}) | SGLang은 "LLM 프로그램"의 실행 효율에 초점을 맞춘 서빙 엔진이다. |
| [Part 2: RadixAttention]({{ site.baseurl }}{% post_url 2026-03-27-sglang-radixattention-vs-pagedattention %}) | Radix tree 기반 KV cache 관리로 요청 간 prefix 공유를 자동화한다. |
| [Part 3: Compressed FSM]({{ site.baseurl }}{% post_url 2026-03-27-sglang-compressed-fsm-structured-output %}) | 결정론적 토큰 구간의 jump-forward로 구조화 출력이 비제약 생성보다 빠를 수 있다. |
| [Part 4: 대규모 운영]({{ site.baseurl }}{% post_url 2026-03-28-sglang-large-scale-gpu-cluster-operations %}) | EP + PD Disaggregation + HiCache + Speculative Decoding의 결합이 프로덕션 성능을 만든다. |
| **Part 5: 선택 가이드** | 항상 X가 좋다는 답은 없다. 워크로드에 맞는 엔진을 선택하라. |

### 결론

SGLang과 vLLM은 경쟁 관계이면서도 서로의 혁신을 흡수하며 빠르게 발전하고 있습니다. vLLM이 APC를 추가하고 XGrammar를 통합한 것, SGLang이 vLLM의 V1 아키텍처에서 영감을 받은 것이 그 증거입니다.

두 엔진 중 하나를 선택해야 한다면, **워크로드의 특성에서 답을 찾아야 합니다.** prefix 공유가 빈번하거나, 구조화 출력이 핵심이거나, 대형 MoE 모델을 서빙해야 한다면 SGLang이 아키텍처적으로 유리합니다. 극단적 동시성, AMD GPU, 또는 성숙한 K8s 생태계가 필요하다면 vLLM이 더 안전한 선택입니다.

무엇을 선택하든, 이 시리즈에서 분석한 아키텍처적 차이를 이해하고 있다면 **왜 그 엔진이 특정 시나리오에서 더 나은지**를 설명할 수 있을 것입니다. 그것이 엔지니어로서의 진정한 역량입니다.

## 참고 자료

### 공식 벤치마크
- LMSYS. (2024). *SGLang v0.4 Release*. [LMSYS Blog](https://lmsys.org/blog/2024-12-04-sglang-v0-4/)
- LMSYS. (2024). *SGLang Llama 3 Serving Benchmarks*. [LMSYS Blog](https://lmsys.org/blog/2024-07-25-sglang-llama3/)
- vLLM. (2024). *vLLM v0.6.0 Performance Update*. [vLLM Blog](https://blog.vllm.ai/2024/09/05/perf-update.html)

### 서드파티 벤치마크
- Spheron. (2026). *vLLM vs TensorRT-LLM vs SGLang Benchmarks on H100*. [Spheron Blog](https://www.spheron.network/blog/vllm-vs-tensorrt-llm-vs-sglang-benchmarks/)
- PremAI. (2026). *vLLM vs SGLang vs LMDeploy: Fastest LLM Inference Engine in 2026*. [PremAI Blog](https://blog.premai.io/vllm-vs-sglang-vs-lmdeploy-fastest-llm-inference-engine-in-2026/)
- Clarifai. (2025). *Comparing SGLang, vLLM, and TensorRT-LLM with GPT-OSS-120B*. [Clarifai Blog](https://www.clarifai.com/blog/comparing-sglang-vllm-and-tensorrt-llm-with-gpt-oss-120b)
- RunPod. (2025). *SGLang vs vLLM: Multi-Turn Conversations and KV Cache Reuse*. [RunPod Blog](https://www.runpod.io/blog/sglang-vs-vllm-kv-cache)
- SqueezeBits. (2025). *Guided Decoding Performance: vLLM vs SGLang*. [SqueezeBits Blog](https://blog.squeezebits.com/guided-decoding-performance-vllm-sglang)
- dstack. (2025). *H200 and MI300X DeepSeek Benchmarks*. [dstack Blog](https://dstack.ai/blog/h200-mi300x-deepskeek-benchmark/)
- Cerebrium. (2024). *Benchmarking vLLM, SGLang, TensorRT for Llama 3.1*. [Cerebrium Blog](https://www.cerebrium.ai/blog/benchmarking-vllm-sglang-tensorrt-for-llama-3-1-api)
- ersteiger. (2025). *vLLM vs SGLang vs MAX*. [ersteiger.com](https://www.ersteiger.com/posts/vllm-vs-max/)
- DEV Community. (2025). *Concurrent LLM Serving: vLLM vs SGLang vs Ollama*. [DEV Community](https://dev.to/zkaria_gamal_3cddbbff21c8/concurrent-llm-serving-benchmarking-vllm-vs-sglang-vs-ollama-1cpn)
