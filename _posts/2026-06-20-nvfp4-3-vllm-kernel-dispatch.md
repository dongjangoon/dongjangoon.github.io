---
layout: single
title: "4비트로 LLM 돌리기 (3) — 커널과 vLLM의 양자화 디스패치"
date: 2026-06-20 09:00:00 +0000
last_modified_at: 2026-06-20
categories: [ai, infrastructure]
tags: [llm, quantization, nvfp4, vllm, cuda, kernel, cutlass, marlin, flashinfer, compressed-tensors, moe, sm120]
excerpt: "하드웨어가 native FP4를 계산할 수 있어도, 그걸 호출하는 '커널'이 없으면 소용이 없습니다. 커널이 무엇인지부터 vLLM이 양자화 가중치를 읽어 레이어마다 백엔드를 고르는 디스패치 체인, 그리고 native 커널이 없을 때의 Marlin 폴백까지 따라가 봅니다."
---

**이 글은 AI를 활용하여 작성되었습니다.**
{: .notice--info}

> 이 글의 코드 경로·이슈 상태는 빠르게 바뀌는 영역이라 **현재 시점(2026년 6월) 기준**으로 정리했습니다. vLLM은 이 시점 기준 0.2x 버전대로 올라와 있으며([vLLM Releases](https://github.com/vllm-project/vllm/releases)), 세부 구현은 버전에 따라 달라질 수 있습니다.
{: .notice--warning}

## 들어가며

[2편]({% post_url 2026-06-19-nvfp4-2-gpu-tensor-core-hardware %})은 한 가지 질문으로 끝났습니다. **하드웨어가 native FP4를 계산할 수 있어도, 그걸 실제로 호출하는 "커널"이 없으면 어떻게 될까요?** 그리고 vLLM은 내 GPU와 모델 포맷을 보고 어떤 커널을 고를까요?

이번 편은 그 소프트웨어 층입니다. "RTX 5070 Ti에서 토큰 하나가 NVFP4로 나오기까지"라는 관통 예제에서, 1편이 숫자를, 2편이 칩을 다뤘다면, 이번 편은 **그 사이를 잇는 코드**를 봅니다. 커널이 무엇인지부터, vLLM이 양자화 가중치를 받아 forward를 돌기까지의 디스패치 체인, 그리고 native 커널이 없을 때 무슨 일이 벌어지는지까지 따라갑니다.

> **시리즈 구성**
> 1. [숫자 편]({% post_url 2026-06-19-nvfp4-1-floating-point-quantization %}) — 부동소수점, NVFP4의 스케일링 트릭
> 2. [하드웨어 편]({% post_url 2026-06-19-nvfp4-2-gpu-tensor-core-hardware %}) — GPU / SM / 텐서코어, native FP4 vs 에뮬레이션
> 3. **소프트웨어 편 (이 글)** — 커널이란 무엇인가, vLLM의 양자화 디스패치 체인
> 4. [실측 편]({% post_url 2026-06-20-nvfp4-4-benchmarks %}) — RTX 5070 Ti에서 NVFP4 직접 서빙하고 벤치마크

## 1. 커널이란 무엇인가

GPU 맥락에서 **커널(kernel)** 은 **GPU 위에서 수천 개의 스레드로 동시에 도는 함수**를 가리킵니다(운영체제의 커널과는 다른 말입니다). 2편에서 본 SM과 텐서코어 위에서 실제로 실행되는 코드 한 덩어리가 커널입니다.

LLM 추론에서 가장 중요한 커널은 **GEMM 커널**입니다. GEMM(General Matrix Multiply)은 행렬곱을 뜻하고, GEMM 커널은 그 행렬곱을 GPU에서 구현한 함수입니다. 트랜스포머의 거의 모든 무거운 연산(QKV 프로젝션, FFN 등)이 결국 행렬곱이라, 이 커널이 얼마나 효율적이냐가 성능을 좌우합니다.

양자화가 들어오면 GEMM 커널도 포맷에 맞게 달라집니다. NVFP4용 dense GEMM 커널인 **`nvfp4_scaled_mm`** 류가 하는 일을 한 줄로 요약하면 이렇습니다.

> **FP4로 저장된 입력을 텐서코어에 그대로 먹이고, 1편에서 본 블록 스케일(FP8)과 글로벌 스케일(FP32)을 곱해 원래 크기로 복원하면서 행렬곱을 수행**한다.

즉 1편의 two-level scaling과 2편의 native FP4 텐서코어가, 코드 레벨에서는 이 커널 하나로 합쳐집니다. vLLM의 FP4 커널은 CUTLASS(NVIDIA의 GPU 행렬 연산 템플릿 라이브러리)를 기반으로 구현돼 있습니다 ([vLLM — compressed_tensors_w4a4_nvfp4](https://docs.vllm.ai/en/latest/api/vllm/model_executor/layers/quantization/compressed_tensors/schemes/compressed_tensors_w4a4_nvfp4/)).

## 2. vLLM은 양자화 가중치를 어떻게 알아보는가

vLLM이 NVFP4 커널을 부르려면, 먼저 **이 모델이 NVFP4로 양자화돼 있다는 사실**을 알아야 합니다. 이 정보는 Hugging Face 모델에 함께 들어 있는 **양자화 설정(config)** 에서 읽습니다. 현재 NVFP4 체크포인트는 크게 두 갈래의 포맷으로 유통됩니다.

| 포맷 | 만든 도구 | vLLM이 읽는 곳 | 지정 방법 |
|------|-----------|----------------|-----------|
| **compressed-tensors** | llm-compressor | `config.json`의 `quantization_config` | 자동 감지 |
| **ModelOpt FP4** | NVIDIA ModelOpt | `hf_quant_config.json` | `quantization="modelopt_fp4"` |

compressed-tensors 포맷이면 vLLM은 설정에서 스킴이 **W4A4 NVFP4**(가중치·활성값 모두 4비트)임을 읽고, 그에 맞는 스킴 클래스(`CompressedTensorsW4A4Fp4`)를 레이어에 붙입니다. ModelOpt 체크포인트는 `hf_quant_config.json`으로 감지해 `modelopt_fp4` 경로를 탑니다 ([vLLM — NVIDIA ModelOpt](https://docs.vllm.ai/en/stable/features/quantization/modelopt/)).

이때 1편에서 만든 스케일 메타데이터(블록당 FP8 스케일, 텐서당 FP32 글로벌 스케일)도 가중치와 함께 로드됩니다. 커널이 복원에 쓸 재료가 이 단계에서 준비되는 셈입니다.

## 3. 디스패치 체인 — 레이어마다 백엔드를 고른다

여기가 이번 편의 핵심입니다. "NVFP4 모델이다"라고 끝나는 게 아니라, vLLM은 **레이어마다** 어떤 커널(백엔드)로 계산할지를 고릅니다. 선택의 기준은 대략 세 가지의 조합입니다.

1. **포맷** — NVFP4인가, dense 레이어인가 MoE 레이어인가
2. **SM** — 지금 GPU의 compute capability가 무엇인가 (2편의 `sm_100` / `sm_120`)
3. **라이브러리** — 그 조합을 처리할 커널이 빌드돼 있고 사용 가능한가 (CUTLASS, FlashInfer 등)

이 판단의 한 예가 **`cutlass_scaled_mm_supports_fp4`** 같은 capability 체크 함수입니다. 이름 그대로 "지금 이 장치에서 CUTLASS FP4 scaled-mm 경로를 쓸 수 있는가"를 물어보고, 가능하면 native `nvfp4_scaled_mm` 커널을, 아니면 다른 경로를 고릅니다.

![vLLM NVFP4 디스패치 체인 — quant config 읽기 → 레이어별 백엔드 선택(SM·라이브러리 확인) → native 커널 또는 Marlin 폴백 → forward → PagedAttention/continuous batching](/assets/images/posts/nvfp4/vllm-dispatch.svg)

선택이 끝나면 forward(순전파)에서 레이어마다 그 커널이 호출됩니다. 그리고 이 GEMM 커널들 **위에** vLLM의 서빙 엔진이 얹힙니다. KV 캐시를 페이지 단위로 관리하는 **PagedAttention**(→ [vLLM PagedAttention]({% post_url 2025-11-04-vllm-pagedattention %}))과, 요청을 동적으로 묶는 **continuous batching**(→ [LLM 추론의 Memory-Bound 특성]({% post_url 2026-01-11-llm-inference-memory-bound %}), [vLLM 비동기 스케줄링]({% post_url 2026-02-08-vllm-async-scheduling %}))이 그 층입니다. 양자화 커널은 이 스택의 가장 아래에서 행렬곱을 담당하는 부품인 셈입니다.

## 4. native 커널이 없으면 — Marlin 폴백

디스패치에서 native FP4 경로를 못 고르면, vLLM은 보통 **Marlin** 백엔드로 떨어집니다. Marlin은 잘 최적화된 양자화 GEMM 커널이지만, FP4를 텐서코어에서 직접 계산하지는 않습니다. 동작은 **4비트로 저장된 가중치를 읽어와 계산 직전에 고정밀(FP16/BF16)로 펴서 곱하는** 방식, 즉 2편에서 본 **에뮬레이션 경로(W4A16)** 와 같습니다.

결과도 2편에서 정리한 그대로입니다.

- **메모리는 절약됩니다** — 어차피 4비트로 읽으니 디코딩(memory-bound)에서는 이득이 남습니다.
- **연산은 가속되지 않습니다** — 곱셈은 16비트로 돌고, 펴는 비용까지 더해집니다.

이 구분은 [AWQ 글]({% post_url 2026-01-11-awq-quantization-performance %})에서 다룬 W4A16과 정확히 같은 이야기입니다. 그래서 "NVFP4 모델을 올렸는데 왜 기대만큼 안 빠르지?"의 답이 종종 여기에 있습니다. **하드웨어는 native FP4가 되는데, 디스패치가 Marlin으로 빠진 경우**입니다.

## 5. dense vs MoE, 그리고 SM120의 현실

그 전에 두 아키텍처의 차이를 짧게 정리합니다. 트랜스포머 레이어는 보통 어텐션과 **FFN(feed-forward network)** 으로 이뤄지는데, 둘의 차이는 이 FFN에 있습니다.

- **dense** — 큰 FFN 하나로, **모든 토큰이 전체 가중치를 다 통과**합니다.
- **MoE(Mixture-of-Experts)** — FFN을 여러 개의 작은 **전문가(expert)** 로 쪼개고, 앞단의 **라우터(router)** 가 토큰마다 그중 일부(top-k)만 골라 보냅니다. 나머지 전문가는 그 토큰을 계산하지 않습니다.

| | dense | MoE |
|---|---|---|
| 토큰당 계산(active) | 전체 가중치 | 선택된 expert만 |
| VRAM | 전체 = active | **전체를 다 올려야 함** (active보다 큼) |
| 표기 예 | "8B" | "30B-A3B" (전체 30B, 활성 3B) |

핵심은 MoE가 **메모리에는 전체를 다 올리면서 연산은 일부만** 한다는 점입니다. 그래서 16GB 카드에서는 MoE의 용량 압박이 더 크고(양자화가 더 절실), 라우팅 때문에 커널 구조도 달라집니다.

같은 NVFP4라도 이 레이어 종류에 따라 커널 경로가 갈립니다.

- **dense 레이어** — 일반적인 행렬곱. `nvfp4_scaled_mm` 같은 scaled GEMM 커널을 씁니다.
- **MoE 레이어** — 토큰을 expert별로 분류해 각 그룹을 다른 가중치로 곱한 뒤 다시 합쳐야 하므로, 여러 전문가의 행렬곱을 묶어 처리하는 **grouped/fused MoE GEMM** 커널이 따로 필요합니다. dense의 단순한 "행렬 × 행렬"보다 훨씬 복잡합니다.

문제는 이 둘의 커널 성숙도가 **SM 타깃마다 다르다**는 점입니다. 우리의 RTX 5070 Ti는 2편에서 봤듯 **SM120(소비자 Blackwell)** 입니다. 현재 시점 기준으로 정리하면 이렇습니다.

- **dense NVFP4**: SM120용 native 커널(`nvfp4_scaled_mm_sm120` 계열)이 비교적 일찍 들어왔습니다.
- **MoE NVFP4**: SM120에서 한동안 백엔드 선택 로직이 SM120을 native 경로로 인식하지 못해 **Marlin으로 폴백하거나, 아예 "지원하는 MoE 백엔드가 없다"며 기동에 실패**하는 사례가 보고됐습니다. 관련해 백엔드 선택 함수(`get_mxfp4_backend()` 등)에 SM120 계열을 추가하자는 이슈([vLLM #31085](https://github.com/vllm-project/vllm/issues/31085)), RTX 5090에서 NVFP4 MoE 모델이 기동 실패하는 이슈([vLLM #35065](https://github.com/vllm-project/vllm/issues/35065)), Marlin이 음수 스케일을 가정하지 않아 SM12.x에서 깨지는 버그, 그리고 CUTLASS grouped GEMM이 SM120에서 잘못된 출력을 내다 **FlashInfer의 SM120 패치로 고쳐진 사례**([CUTLASS #3096](https://github.com/NVIDIA/cutlass/issues/3096), [FlashInfer #2577](https://github.com/flashinfer-ai/flashinfer/issues/2577))가 얽혀 있습니다.

여기서 **FlashInfer**가 등장합니다. FlashInfer는 LLM 추론용 고성능 커널 라이브러리로, vLLM은 일부 FP4/MoE 경로를 FlashInfer 커널로 처리하도록 플래그로 전환할 수 있습니다. SM120 MoE 문제의 실질적 해법도 "Marlin 대신 FlashInfer의 CUTLASS SM120 FP4 경로를 강제로 태우는" 방향으로 정리돼 왔습니다.

정리하면, **하드웨어(SM120)는 native FP4가 되는데 소프트웨어 디스패치가 못 따라가던** 전형적인 사례입니다. 이 상태는 버전마다 바뀌므로, 4편에서 우리 카드의 실제 로그로 "지금 내 vLLM이 어떤 경로를 골랐는지"를 직접 확인할 겁니다.

## 6. 가중치는 어디서 오는가 — prequantized HF vs 직접 PTQ

마지막으로 NVFP4 가중치를 손에 넣는 두 가지 길입니다.

- **prequantized 체크포인트 받기** — 이미 NVFP4로 양자화돼 Hugging Face에 올라온 가중치를 그대로 받아 서빙합니다. 가장 간단합니다.
- **직접 PTQ 돌리기** — 원본 모델을 받아 직접 양자화합니다. 도구는 두 가지가 대표적입니다.
  - **llm-compressor** — 레시피 기반으로 양자화하고 **compressed-tensors** 포맷으로 저장 ([llm-compressor — NVFP4 예제](https://docs.vllm.ai/projects/llm-compressor/en/latest/examples/quantization_w4a4_fp4/)).
  - **NVIDIA ModelOpt(TensorRT-Model-Optimizer)** — PTQ 후 `hf_quant_config.json`을 포함한 HF 체크포인트로 저장, vLLM에서 `modelopt_fp4`로 로드 ([NVIDIA Model-Optimizer LLM PTQ](https://github.com/NVIDIA/TensorRT-Model-Optimizer/tree/main/examples/llm_ptq)).

여기서 **PTQ(Post-Training Quantization)** 는 *학습이 끝난 모델을 사후에 양자화*하는 방식입니다. 보정용 샘플(calibration set) 약간이면 되고 재학습이 필요 없어 빠릅니다. 반대로 **QAT(Quantization-Aware Training)** 는 *학습 중에 양자화 오차를 미리 반영*해 저정밀에 강한 가중치를 만드는 방식으로, 사실상 재학습이 필요합니다. 이 시리즈에서 다루는 NVFP4 서빙은 거의 다 **PTQ 경로**이고, QAT는 학습 영역이라 범위 밖입니다.

## 마치며

이번 편에서 따라간 길은 이렇습니다.

- **커널** = GPU에서 수천 스레드로 도는 함수, **GEMM 커널** = 행렬곱 구현, **`nvfp4_scaled_mm`** = FP4 입력에 블록·글로벌 스케일을 곱해 복원하며 행렬곱
- vLLM은 HF의 **양자화 config**(compressed-tensors / ModelOpt)를 읽고, **레이어마다 (포맷 × SM × 라이브러리)** 로 백엔드를 골라 forward에서 커널을 호출 — 그 위에 PagedAttention·continuous batching
- native 경로를 못 고르면 **Marlin 폴백** = 2편의 에뮬레이션(W4A16), 메모리만 절약하고 연산은 못 살림
- **dense는 SM120 native 커널이 비교적 일찍**, **MoE는 SM120에서 폴백·실패가 보고**됨 (현재 시점 기준, FlashInfer 경로로 해결되는 흐름)
- 가중치는 **prequantized HF** 또는 **직접 PTQ(llm-compressor / ModelOpt)** — 모두 PTQ, QAT는 범위 밖

이제 이론은 다 깔렸습니다. 그렇다면 우리의 16GB RTX 5070 Ti에서 NVFP4는 실제로 어떻게 동작할까요? **BF16으로는 안 올라가던 모델이 NVFP4로는 올라가는지**, **속도뿐 아니라 정확도는 얼마나 떨어지는지**, 그리고 **디스패치가 정말 native를 골랐는지 Marlin으로 빠졌는지**를 다음 편에서 직접 측정하고 로그로 확인합니다.

다음 글(실측 편)에서는 재현 가능한 벤치마크 하니스와 함께, TTFT·ITL·throughput에 더해 **정확도 축까지** 놓고 NVFP4를 검증하겠습니다.

## 참고 자료

- vLLM. *compressed_tensors_w4a4_nvfp4 scheme*. [docs.vllm.ai](https://docs.vllm.ai/en/latest/api/vllm/model_executor/layers/quantization/compressed_tensors/schemes/compressed_tensors_w4a4_nvfp4/) — NVFP4 dense 스킴과 CUTLASS 커널
- vLLM. *NVIDIA ModelOpt quantization*. [docs.vllm.ai](https://docs.vllm.ai/en/stable/features/quantization/modelopt/) — `modelopt_fp4` 로딩
- vLLM. *Quantization Methods Overview*. [DeepWiki](https://deepwiki.com/vllm-project/vllm/7.1-quantization-methods-overview) — 디스패치/백엔드 선택 개요
- LLM Compressor. *fp4 Quantization with NVFP4*. [docs.vllm.ai](https://docs.vllm.ai/projects/llm-compressor/en/latest/examples/quantization_w4a4_fp4/) — compressed-tensors PTQ
- NVIDIA. *TensorRT-Model-Optimizer — LLM PTQ*. [GitHub](https://github.com/NVIDIA/TensorRT-Model-Optimizer/tree/main/examples/llm_ptq) — ModelOpt PTQ
- vLLM. *Add SM120 support for native NVFP4 MoE kernels (#31085)*. [GitHub Issue](https://github.com/vllm-project/vllm/issues/31085)
- vLLM. *RTX 5090 (SM120) NVFP4 MoE fails to start (#35065)*. [GitHub Issue](https://github.com/vllm-project/vllm/issues/35065)
- NVIDIA CUTLASS. *SM120 NVFP4 MoE grouped GEMM fix via FlashInfer (#3096)*. [GitHub Issue](https://github.com/NVIDIA/cutlass/issues/3096)
- FlashInfer. *NVFP4 mm_fp4 GEMM on SM120 (#2577)*. [GitHub Issue](https://github.com/flashinfer-ai/flashinfer/issues/2577)
- Sebastian Raschka. *LLM Architecture Gallery*. [sebastianraschka.com](https://sebastianraschka.com/llm-architecture-gallery/) — dense / sparse MoE / hybrid 등 LLM 아키텍처 도감 ([한국어 번역](https://discuss.pytorch.kr/t/llm-llm-architecture-gallery-sebastian-raschka-gpt-2-llm/9241))
