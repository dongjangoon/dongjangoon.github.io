---
layout: single
title: "AWQ 양자화: 7B 모델이 3B보다 빠른 이유"
date: 2025-01-11 00:00:00 +0000
categories: [ai, infrastructure]
tags: [llm, vllm, awq, quantization, gpu, inference, memory-bandwidth, optimization]
excerpt: "AWQ 양자화가 LLM 추론 성능에 미치는 영향을 분석합니다. 왜 7B AWQ 모델이 3B FP16 모델보다 빠른지, 벤치마크 결과와 함께 그 원리를 설명합니다."
---

## 들어가며

"더 큰 모델이 더 느리다"는 것은 직관적으로 당연해 보입니다. 하지만 **양자화(Quantization)**를 적용하면 이 상식이 뒤집어집니다.

이 글에서는 RTX 5070 Ti에서 **Mistral 7B AWQ**와 **Qwen 3B FP16**의 벤치마크를 비교하며, 왜 7B 모델이 3B 모델보다 빠를 수 있는지 그 원리를 살펴보겠습니다.

## 양자화란?

### 기본 개념

양자화는 모델 가중치의 **정밀도(precision)**를 낮추는 기법입니다.

```
FP32 (32bit) → FP16 (16bit) → INT8 (8bit) → INT4 (4bit)
```

정밀도가 낮아질수록
- **장점**: 모델 크기 감소, 메모리 사용량 감소, 추론 속도 향상
- **단점**: 약간의 정확도 손실 가능

### 양자화 방식별 비교

| 방식 | 비트 | 모델 크기 (7B 기준) | 성능 손실 |
|------|-----|-------------------|----------|
| FP16 | 16bit | 14GB | 없음 |
| INT8 | 8bit | 7GB | ~1% |
| **AWQ** | 4bit | 3.5GB | ~2-3% |
| GPTQ | 4bit | 3.5GB | ~3-5% |

### AWQ (Activation-aware Weight Quantization)

AWQ는 2023년에 발표된 4비트 양자화 기법으로, **활성화 분포를 고려**하여 중요한 가중치를 보존합니다:

```
기존 양자화: 모든 가중치를 동일하게 양자화
AWQ: 활성화 분포 분석 → 중요한 채널 식별 → 선택적 스케일링

→ 같은 4비트라도 품질 손실 최소화
```

## 벤치마크 환경

### 테스트 구성

```
GPU: RTX 5070 Ti (16GB VRAM)
CUDA: 13.1

모델 A: Qwen2.5-3B-Instruct (FP16)
  - 파라미터: 3B
  - 가중치 크기: ~6GB

모델 B: Mistral-7B-Instruct-v0.2-AWQ (INT4)
  - 파라미터: 7B
  - 가중치 크기: ~3.5GB
```

### VRAM 사용량

```
Qwen 3B FP16:
  모델 가중치: ~6GB
  GPU 사용률: ~60%

Mistral 7B AWQ:
  모델 가중치: ~3.5GB
  GPU 사용률: ~97%
  (남은 공간은 KV Cache로 활용)
```

## 벤치마크 결과

### Batch Size별 처리량 비교

| Batch | Qwen 3B (FP16) | Mistral 7B (AWQ) | 차이 |
|-------|---------------|------------------|------|
| 1 | 21.0 t/s | 31.1 t/s | **+48%** |
| 2 | 43.2 t/s | 59.1 t/s | +37% |
| 4 | 90.0 t/s | 115.3 t/s | +28% |
| 8 | 182.8 t/s | 231.1 t/s | +26% |
| 16 | 383.6 t/s | 447.8 t/s | +17% |
| 32 | 701.6 t/s | 777.5 t/s | +11% |

```
처리량 비교 그래프:

800 ┤  ●─────● Mistral 7B AWQ
    │ ○─────○ Qwen 3B FP16
700 ┤                    ●
    │                   ○
600 ┤
    │
500 ┤              ●
    │             ○
400 ┤
    │
300 ┤        ●
    │       ○
200 ┤    ●
    │   ○
100 ┤ ●
    │○
    └────────────────────→ Batch Size
     1  2  4  8  16 32
```

### 위에서 알 수 있는 점

1. **모든 배치 크기에서 7B AWQ가 3B FP16보다 빠름**
2. **배치 1에서 가장 큰 차이** (+48%)
3. 배치가 커질수록 차이 감소 (Compute-bound로 전환되면서)

## 왜 7B AWQ가 3B FP16보다 빠른가?

### Memory-Bound 환경에서의 핵심

[이전 글](/ai/infrastructure/llm-inference-memory-bound/)에서 설명했듯이, LLM의 Decode 단계는 **Memory-Bound**입니다. 토큰 하나를 생성할 때마다 모델 전체 가중치를 메모리에서 읽어야 합니다.

```
Decode 처리량 ∝ Memory Bandwidth / 모델 크기
```

### 모델 크기 비교

```
Qwen 3B FP16:   3B × 2 bytes = 6GB
Mistral 7B AWQ: 7B × 0.5 bytes = 3.5GB  ← 절반!
```

파라미터 수는 7B > 3B이지만, **실제 가중치 크기는 3.5GB < 6GB**입니다.

### 이론적 처리량 계산

```
RTX 5070 Ti 메모리 대역폭: ~504 GB/s

이론 최대 처리량:
  Qwen 3B FP16:   504 / 6 = 84 t/s
  Mistral 7B AWQ: 504 / 3.5 = 144 t/s  ← 1.7배!

실제 측정 (Batch=1):
  Qwen 3B FP16:   21 t/s (효율 25%)
  Mistral 7B AWQ: 31 t/s (효율 22%)
```

효율은 비슷하지만, 모델 크기가 작아서 절대 처리량이 더 높습니다.

### 핵심 인사이트

```
┌─────────────────────────────────────────────────────────┐
│                     핵심 공식                            │
│                                                         │
│   파라미터 수 ≠ 추론 속도                                │
│                                                         │
│   추론 속도 ∝ 메모리 대역폭 / 가중치 크기                │
│                                                         │
│   → 양자화로 가중치 크기를 줄이면                        │
│   → 더 큰 모델도 더 빠를 수 있음                        │
└─────────────────────────────────────────────────────────┘
```

## 배치가 커질수록 차이가 줄어드는 이유

### Memory-Bound → Compute-Bound 전환

```
Batch=1:  가중치 로딩이 대부분 → 모델 크기가 결정적
Batch=32: 연산이 많아짐 → GPU 연산 능력이 중요해짐
```

배치 크기가 커지면 **Compute-Bound**로 전환되면서, 모델 크기보다 **파라미터 수(연산량)**가 중요해집니다.

```
배치별 차이:
Batch 1:  +48% (Memory-bound, 모델 크기 차이가 크게 작용)
Batch 4:  +28% (전환 구간)
Batch 32: +11% (Compute-bound, 연산량 차이로 역전 가능성)
```

### INT4 연산의 특수성

AWQ는 INT4로 저장하지만, 추론 시에는 FP16으로 변환하여 연산합니다.

```
저장: INT4 (3.5GB)
연산: INT4 → FP16 변환 → Tensor Core 연산

→ 메모리 읽기는 INT4 이득
→ 연산은 FP16과 동일
```

일부 최신 GPU에서는 INT4 직접 연산을 지원하여 추가 성능 향상이 가능합니다.

## AWQ vs GPTQ

두 방식 모두 4비트 양자화지만 접근 방식이 다릅니다.

| 특성 | AWQ | GPTQ |
|------|-----|------|
| 양자화 방식 | 활성화 기반 스케일링 | 레이어별 최적화 |
| 캘리브레이션 | 경량 (분 단위) | 무거움 (시간 단위) |
| 품질 손실 | ~2-3% | ~3-5% |
| 추론 속도 | 빠름 | 비슷함 |
| vLLM 지원 | 네이티브 | 네이티브 |

### vLLM에서 AWQ 사용

```bash
# AWQ 모델 로드
vllm serve TheBloke/Mistral-7B-Instruct-v0.2-AWQ \
  --quantization awq \
  --gpu-memory-utilization 0.90
```

### 모델 선택 전략

```
16GB VRAM 기준

보수적 선택: Qwen 3B FP16
  - 품질 손실 없음
  - KV Cache 여유 많음
  - 동시 요청 많이 처리 가능

공격적 선택: Mistral 7B AWQ
  - 더 높은 처리량
  - 더 큰 모델의 품질
  - VRAM 빠듯 (KV Cache 여유 적음)

균형점: 7B AWQ
  - 3B FP16 대비 48% 빠름
  - 7B 모델의 성능
  - 품질 손실 최소화 (AWQ)
```

## 결론

"더 큰 모델이 더 느리다"는 상식은 **양자화 환경에서는 적용되지 않습니다**. LLM 추론이 Memory-Bound이기 때문에, **가중치 크기**가 처리량을 결정합니다.

벤치마크 결과
- **Mistral 7B AWQ (3.5GB)**가 **Qwen 3B FP16 (6GB)**보다 **48% 빠름**
- 배치가 커질수록 차이 감소 (Compute-bound 전환)
- 모든 배치 크기에서 AWQ가 우위

핵심 인사이트
1. **파라미터 수 ≠ 추론 속도**: 가중치 크기가 핵심
2. **양자화는 품질 희생이 아님**: AWQ는 2-3% 손실로 48% 성능 향상
3. **VRAM 빠듯할수록 양자화 효과 극대화**: Memory-bound 구간에서 이득

## Reference

- [AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration](https://arxiv.org/abs/2306.00978)
- [vLLM Quantization Documentation](https://docs.vllm.ai/en/latest/quantization/supported_hardware.html)
- [TheBloke's Quantized Models on Hugging Face](https://huggingface.co/TheBloke)
- [GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers](https://arxiv.org/abs/2210.17323)
