---
layout: single
title: "4비트로 LLM 돌리기 (4) — RTX 5070 Ti에 NVFP4 직접 올려본 기록"
date: 2026-06-20 12:00:00 +0000
last_modified_at: 2026-06-20
categories: [ai, infrastructure]
tags: [llm, quantization, nvfp4, vllm, benchmark, rtx5070ti, sm120, mmlu, throughput, fp8, model-runner-v2]
excerpt: "1~3편에서 정리한 이론을, 손에 있는 16GB RTX 5070 Ti에 직접 올려서 확인해 본 기록입니다. BF16로는 안 올라가던 모델이 NVFP4로는 올라가는지, 디스패치가 native FP4를 골랐는지, 속도와 정확도는 어떤지를 터미널에 찍힌 로그 그대로 옮겨 봤습니다. 전문 벤치마크라기보다, 공부하면서 돌려본 메모에 가깝습니다."
---

**이 글은 AI를 활용하여 작성되었습니다.**
{: .notice--info}

> 측정 환경은 **RTX 5070 Ti(Blackwell, SM120, 16GB) + WSL2 위의 k3s 단일 노드 + vLLM v0.23.0**(`vllm/vllm-openai:latest`)입니다. 전문적인 벤치마크 셋업이 아니라 집에 있는 카드 한 장으로 돌려본 거라, 절대 수치보다는 **같은 카드에서 포맷만 바꿨을 때의 상대 차이** 정도로 봐 주세요. WSL 특성이나 버전에 따라 결과는 달라질 수 있습니다.
{: .notice--warning}

## 들어가며

[3편]({% post_url 2026-06-20-nvfp4-3-vllm-kernel-dispatch %})까지 NVFP4가 무엇이고(1편), 어떤 하드웨어가 그걸 계산하며(2편), vLLM이 어떻게 커널을 고르는지(3편)를 글로만 따라왔습니다. 그런데 글로 정리하다 보니 "그래서 내 카드에서는 실제로 어떻게 되는데?"가 계속 걸렸습니다. 특히 3편 마지막의 **"하드웨어는 native FP4가 되는데 디스패치가 못 따라가던"** 이야기는 버전마다 바뀌는 영역이라, 직접 로그를 봐야 할 것 같았습니다.

그래서 이번 편은 손에 있는 16GB RTX 5070 Ti에 Qwen3 계열 모델을 BF16 / FP8 / NVFP4로 올려가며 세 가지를 확인해 본 기록입니다.

1. **적재** — 16GB 안에 들어가는가. BF16는 안 되고 NVFP4는 되는지.
2. **디스패치** — vLLM이 native FP4 커널을 골랐는지, 3편에서 본 Marlin 폴백인지.
3. **속도·정확도** — NVFP4가 FP8보다 빠른지, 4비트라 정확도는 얼마나 떨어지는지.

> **시리즈 구성**
> 1. [숫자 편]({% post_url 2026-06-19-nvfp4-1-floating-point-quantization %}) — 부동소수점, NVFP4의 스케일링 트릭
> 2. [하드웨어 편]({% post_url 2026-06-19-nvfp4-2-gpu-tensor-core-hardware %}) — GPU / SM / 텐서코어, native FP4 vs 에뮬레이션
> 3. [소프트웨어 편]({% post_url 2026-06-20-nvfp4-3-vllm-kernel-dispatch %}) — 커널이란 무엇인가, vLLM의 양자화 디스패치 체인
> 4. **실측 편 (이 글)** — RTX 5070 Ti에 NVFP4 직접 올려보기

미리 한 가지만 적어 둡니다. 저도 배우면서 돌려본 거라, **잘 안 된 것도 그대로 적었습니다.** 측정에 실패한 칸이 몇 개 있는데, 오히려 거기서 더 많이 배웠습니다.

## 1. 측정 환경과 모델

측정은 호스트가 아니라 **k3s 파드 안의 vLLM**에서 했습니다(호스트에 torch·vllm을 안 깔아도 돼서 편했습니다). 모델은 게이팅이 없는 Qwen3 계열로 통일해서, 같은 크기에서 **포맷만 바꿔** 비교할 수 있게 했습니다.

| 태그 | 모델 | 포맷 | 보려던 것 |
|------|------|------|-----------|
| A | Qwen3-8B | BF16 | 양자화 안 한 기준선 |
| B | Qwen3-8B | FP8 (dynamic) | 8비트 |
| C | Qwen3-8B | **NVFP4** | 4비트, A·B와 같은 크기 비교 |
| D | Qwen3-14B | **NVFP4** | NVFP4로 한 체급 위까지 |
| E | Qwen3-30B-A3B | **NVFP4 (MoE)** | 4비트로도 16GB를 넘는 경계 |

공통 조건은 `--gpu-memory-utilization 0.90 --max-model-len 8192`, 속도는 입력 512 / 출력 128 토큰에 `--temperature 0 --ignore-eos`(디코드 길이·그리디 고정), 정확도는 MMLU 5-shot입니다. 도구는 vLLM 내장 `vllm bench serve`와 `lm-eval`을 그대로 썼습니다.

## 2. 16GB 안에 뭐가 들어가나

가장 궁금했던 건 "그래서 올라가긴 하느냐"였습니다. NVFP4 8B를 띄웠을 때 기동 로그는 이랬습니다.

```text
Using FlashInferCutlassNvFp4LinearKernel for NVFP4 GEMM
...
weights memory: 5.98GiB.
Available KV cache memory: 6.63 GiB
GPU KV cache size: 48,272 tokens
Maximum concurrency for 8,192 tokens per request: 5.89x
```

가중치 5.98GiB만 쓰고 KV 캐시로 6.63GiB가 남아, 동시성이 5.89x까지 떴습니다. 같은 식으로 다섯 모델을 다 띄워 본 결과를 모으면 이렇습니다(weights·KV는 전부 기동 로그 실측값).

| 모델 | 포맷 | weights | 적재 | KV 캐시 | 동시성 |
|------|------|---------|:----:|---------|:------:|
| Qwen3-8B | BF16 | 15.27 GiB | ❌ | 공간 없음 | — |
| Qwen3-8B | FP8 | 8.8 GiB | ✅ | 3.9 GiB | 3.47x |
| Qwen3-8B | **NVFP4** | **5.98 GiB** | ✅ | **6.63 GiB** | **5.89x** |
| Qwen3-14B | **NVFP4** | 9.97 GiB | ✅ | 2.43 GiB | 1.94x |
| Qwen3-30B-A3B | NVFP4 (MoE) | 16.86 GiB | ❌ | 공간 없음 | — |

**BF16 8B는 안 올라갔습니다.** 가중치만 15.27GiB라 16GB 카드를 거의 다 먹어서, KV 캐시 잡을 자리가 안 남습니다. 흔히 떠올리는 "CUDA out of memory"가 아니라 이런 메시지가 떴습니다.

```text
Model loading took 15.27 GiB memory and 250.46 seconds
...
ValueError: No available memory for the cache blocks.
Try increasing `gpu_memory_utilization` when initializing the engine.
```

*가중치는 올라갔는데 KV 캐시 블록을 잡을 메모리가 없다*는 뜻입니다. 그리고 같은 메시지로 막힌 게 하나 더 있었는데, **NVFP4 30B MoE**입니다. [3편]({% post_url 2026-06-20-nvfp4-3-vllm-kernel-dispatch %})에서 본 것처럼 MoE는 active가 3B여도 **전체 30B를 다 올려야** 해서, NVFP4로 줄여도 weights가 16.86GiB라 역시 16GB를 넘었습니다. 4비트도 만능은 아니더군요.

그 사이에서 NVFP4가 8B를 5.98GiB로 줄여 여유 있게 올렸고, FP8(8.8GiB)보다 KV 여력도 더 컸습니다. 한 체급 위인 14B도 NVFP4로는 올라갔고요(다만 KV가 빠듯해 동시성 1.94x). 적어도 제 카드에서는, **양자화의 첫 번째 효용이 속도보다 "일단 올라가느냐"** 쪽에 더 가깝게 느껴졌습니다.

## 3. 디스패치 확인 — native였나, 폴백이었나

3편에서 제일 걱정했던 건 "디스패치가 native를 못 고르고 Marlin으로 빠지면, 메모리만 줄고 속도는 안 난다"였습니다. 그래서 기동 로그에서 레이어가 실제로 고른 커널 이름을 찾아봤습니다. 2절 로그 첫 줄에 이미 나와 있던 그 줄입니다.

```text
Using FlashInferCutlassNvFp4LinearKernel for NVFP4 GEMM
```

NVFP4 세 모델(8B·14B dense, 30B MoE)이 **모두** 이 줄을 찍었습니다. 3편에서 정리한 그 경로 — Marlin 폴백이 아니라 FlashInfer의 CUTLASS SM120 FP4 커널 — 을 v0.23.0에서는 dense·MoE 모두 가리키고 있었습니다. SM120에서 NVFP4 MoE가 폴백·기동 실패하던([vLLM #31085](https://github.com/vllm-project/vllm/issues/31085)) 시기 이야기를, 적어도 이 버전에서는 넘어선 것으로 보입니다.

다만 솔직히 적으면, **30B MoE는 이 커널이 "선택"된 줄까지만 남기고 그 직후 KV 부족으로 죽었습니다**(2절). 그래서 native를 고르는 것까지는 봤지만, 그 커널로 토큰을 끝까지 뽑은 건 8B·14B dense입니다.

## 4. 속도 — NVFP4 vs FP8 (같은 8B)

같은 8B를 NVFP4와 FP8로 놓고 동시성을 올려가며 처리량을 봤습니다. NVFP4 8B의 동시성 16 구간 출력은 이랬습니다.

```text
============ Serving Benchmark Result ============
Successful requests:                     320
Maximum request concurrency:             16
Request throughput (req/s):              10.41
Output token throughput (tok/s):         1332.07
Median TTFT (ms):                        235.48
Median TPOT (ms):                        10.08
```

FP8로 같은 조건을 돌리면 같은 구간이 804 tok/s 정도였습니다. 동시성별로 모으면 이렇습니다.

| 동시성 | NVFP4 출력 tok/s | NVFP4 TPOT | FP8 출력 tok/s | FP8 TPOT |
|:---:|:---:|:---:|:---:|:---:|
| 1 | 124 | 7.74 ms | 78 | 12.40 ms |
| 4 | 462 | 8.16 ms | 293 | 12.70 ms |
| 8 | 807 | 8.54 ms | 492 | 14.16 ms |
| 16 | **1332** | 10.08 ms | **804** | 16.69 ms |

(TPOT = 토큰당 생성 시간, 작을수록 빠름)

제 환경에서는 **NVFP4가 FP8보다 1.5~1.6배쯤 빨랐습니다.** 흥미로웠던 건 이게 단지 메모리가 작아서가 아닌 것 같다는 점입니다. [2편]({% post_url 2026-06-19-nvfp4-2-gpu-tensor-core-hardware %})에서 본 **Blackwell의 native FP4 텐서코어가 4비트를 직접 계산**하는데, 3절에서 디스패치가 native였음을 확인했으니, 이 차이를 "에뮬레이션이 아니라 진짜 연산 가속"으로 읽어도 될 듯합니다.

참고로 14B NVFP4도 생각보다 쓸 만했습니다. 동시성 16에서 873 tok/s, TPOT 15.9ms로 8B FP8과 비슷한 토큰 지연이었습니다. 4비트 14B가 8비트 8B 수준 속도로 도는 셈이라, NVFP4의 또 다른 쓸모를 본 느낌이었습니다.

## 5. 정확도 — 4비트의 대가는 얼마였나

속도가 빨라도 답이 틀리면 의미가 없으니, MMLU(5-shot)로 정확도도 봤습니다. `lm-eval`이 찍은 집계 줄을 그대로 옮기면 이렇습니다.

```text
# NVFP4 8B
|mmlu  |  2|none|  |acc|  |0.7675|±|0.0121|

# FP8 8B
|mmlu  |  2|none|  |acc|  |0.7763|±|0.0119|
```

제 측정에서는 **4비트(NVFP4)가 8비트(FP8) 대비 0.88%p 낮았습니다.** 비트를 절반으로 줄였는데 손실이 1%p 안쪽이라, 1편의 two-level 스케일링이 4비트의 좁은 표현 범위를 어느 정도 받쳐 주는 것 같았습니다(정확한 기여도까지는 저도 잘 모르겠습니다).

다만 한계가 두 개 있습니다. 첫째, **BF16 기준선이 없습니다.** BF16 8B가 16GB에 안 올라가서(2절) 비교 대상 자체를 못 만들었습니다. 그래서 "NVFP4가 원본 정확도의 몇 %를 회복했는가"는 제 환경에선 말 못 하고, **NVFP4 vs FP8까지만** 비교할 수 있습니다. 둘째, **14B NVFP4 정확도는 못 쟀습니다** — KV가 빠듯해서(2.43GiB) MMLU 평가가 제한 시간 안에 안 끝났습니다. 표에 14B가 없는 건 그래서입니다.

> MMLU는 대표 서브셋으로만 돌렸습니다. 그래서 절대 점수보다 **포맷 간 차이**를 보는 용도이고, 공식 풀세트 점수와는 다를 수 있습니다.

## 6. 삽질 메모 — WSL이면 Model Runner V2를 끄자

마지막으로 한참 헤맸던 부분 하나를 남겨 둡니다. BF16 모델만 자꾸 메모리와 무관한 에러로 죽었습니다.

```text
RuntimeError: UVA is not available
```

원인은 **Model Runner V2(MRV2)**였습니다. vLLM이 실행 코어를 새로 쓴 MRV2를 **v0.22.0부터 Qwen3 dense 모델에 기본 적용**했고, **v0.23.0에서 Llama·Mistral dense로 확대**했더군요(양자화 모델은 아직 기존 V1으로 돕니다). MRV2가 일부 버퍼에 **UVA(통합 가상 주소, CUDA managed memory)**를 쓰는데 **WSL2는 이걸 지원하지 않아서**, dense·비양자화 모델이 V2로 뜨면 가중치를 올리기도 전에 죽습니다. NVFP4·FP8가 멀쩡했던 건 양자화라 V1으로 돌았기 때문이었고요.

해결은 환경변수 하나였습니다.

```text
VLLM_USE_V2_MODEL_RUNNER=0
```

이걸로 V1을 강제하니 UVA 경로를 안 타고, 그제서야 BF16의 진짜 결과(2절의 "KV 공간 부족")를 볼 수 있었습니다. 혹시 **WSL에서 vLLM을 쓰는데 dense 모델이 이상하게 죽는다면, V1으로 두는 걸** 권합니다.

## 마치며

손에 있는 16GB RTX 5070 Ti로 돌려본 결과를 정리하면 이렇습니다(전부 제 환경 기준).

- **적재** — BF16 8B는 안 올라가고(KV 공간 없음), NVFP4가 8B는 여유 있게, 14B까지 올림. 단 NVFP4 30B MoE는 여전히 16GB 밖.
- **디스패치** — NVFP4 dense·MoE 모두 기동 로그가 `FlashInferCutlassNvFp4LinearKernel`(native FP4)을 가리킴. 3편의 Marlin 폴백 걱정은 이 버전에선 안 보였음.
- **속도** — 같은 8B에서 NVFP4가 FP8보다 1.5~1.6배 빨랐음(동시성 16, 1332 vs 804 tok/s).
- **정확도** — NVFP4가 FP8 대비 −0.88%p(MMLU 0.7675 vs 0.7763).
- **삽질** — WSL에서는 Model Runner V2의 UVA 때문에 dense 모델이 죽을 수 있음 → `VLLM_USE_V2_MODEL_RUNNER=0`.

그리고 못 한 것도 적어 둡니다. **BF16 정확도 기준선**(적재 실패)과 **14B NVFP4 정확도**(시간 초과)는 측정하지 못했습니다. 더 깔끔하게 하려면 카드가 더 크거나, 평가 설정을 손봐야 할 것 같습니다.

1편의 숫자에서 출발해서 여기까지, 결국 제가 확인하고 싶었던 건 "이 이론이 내 카드에서 진짜 그렇게 도느냐"였습니다. 완벽한 벤치마크는 아니지만, NVFP4가 적어도 이 16GB 카드에서는 **"안 올라가던 모델을 올려 주고, 그러면서 정확도는 거의 지키더라"** 정도는 직접 눈으로 본 셈입니다. 비슷한 카드로 공부하시는 분께 작은 참고가 되면 좋겠습니다.

## 참고 자료

- vLLM. *Releases (v0.22.0, v0.23.0)*. [GitHub](https://github.com/vllm-project/vllm/releases) — Model Runner V2 dense 기본 적용 시점
- vLLM. *Model Runner V2: A Modular and Faster Core for vLLM*. [vLLM Blog](https://vllm.ai/blog/2026-03-24-mrv2)
- vLLM. *Model Runner V2 Design Document*. [docs.vllm.ai](https://docs.vllm.ai/en/latest/design/model_runner_v2/)
- vLLM. *Add SM120 support for native NVFP4 MoE kernels (#31085)*. [GitHub Issue](https://github.com/vllm-project/vllm/issues/31085)
- vLLM. *compressed_tensors_w4a4_nvfp4 scheme*. [docs.vllm.ai](https://docs.vllm.ai/en/latest/api/vllm/model_executor/layers/quantization/compressed_tensors/schemes/compressed_tensors_w4a4_nvfp4/)
- EleutherAI. *lm-evaluation-harness*. [GitHub](https://github.com/EleutherAI/lm-evaluation-harness) — MMLU 측정 도구
- Red Hat AI. *Qwen3 NVFP4 / FP8 quantized checkpoints*. [Hugging Face](https://huggingface.co/RedHatAI) — 실측에 쓴 prequantized 모델
