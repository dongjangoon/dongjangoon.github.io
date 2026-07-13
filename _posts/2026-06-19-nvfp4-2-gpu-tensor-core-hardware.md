---
layout: single
title: "4비트로 LLM 돌리기 (2) — GPU·SM·텐서코어, 그리고 native FP4"
date: 2026-06-19 12:00:00 +0000
last_modified_at: 2026-06-19
categories: [ai, infrastructure]
tags: [llm, quantization, nvfp4, fp4, gpu, tensor-core, blackwell, sm120, sm100, cuda, inference]
excerpt: "1편에서 만든 4비트 숫자를 GPU가 실제로 빠르게 곱하려면 전용 하드웨어가 필요합니다. CPU와 GPU의 차이, SM과 텐서코어가 무엇인지, 그리고 왜 NVFP4가 Blackwell 세대에서만 진짜 빠른지(native FP4 vs 에뮬레이션)를 처음 보는 사람도 이해할 수 있게 풀어봅니다."
published: false
---

**이 글은 AI를 활용하여 작성되었습니다.**
{: .notice--info}

## 들어가며

[1편]({% post_url 2026-06-19-nvfp4-1-floating-point-quantization %})에서는 BF16 가중치를 NVFP4로 바꿔 메모리에서 옮길 바이트를 1/4로 줄였습니다. 그런데 1편 마지막에 한 가지를 미뤄뒀습니다. **그렇게 만든 4비트 곱셈을 GPU가 실제로 빠르게 계산하려면 전용 하드웨어가 필요하다**는 점입니다. 4비트로 저장만 하고 계산할 때 다시 16비트로 펴버리면, 메모리는 아꼈어도 연산 속도 이득은 따로 챙겨야 합니다.

이번 글은 그 하드웨어 쪽 이야기입니다. "RTX 5070 Ti에서 토큰 하나가 NVFP4로 나오기까지"라는 시리즈의 관통 예제에서, 이번 편은 **그 토큰을 실제로 계산하는 칩의 구조**를 봅니다. GPU와 CPU가 왜 다른지부터 시작해 SM과 텐서코어를 거쳐, 왜 NVFP4가 Blackwell 세대에서만 진짜 빠른지까지 쌓아 올립니다.

> **시리즈 구성**
> 1. [숫자 편]({% post_url 2026-06-19-nvfp4-1-floating-point-quantization %}) — 부동소수점, NVFP4의 스케일링 트릭
> 2. **하드웨어 편 (이 글)** — GPU / SM / 텐서코어, native FP4 vs 에뮬레이션
> 3. [소프트웨어 편]({% post_url 2026-06-20-nvfp4-3-vllm-kernel-dispatch %}) — 커널이란 무엇인가, vLLM의 양자화 디스패치 체인
> 4. [실측 편]({% post_url 2026-06-20-nvfp4-4-benchmarks %}) — RTX 5070 Ti에서 NVFP4 직접 서빙하고 벤치마크

## 1. CPU와 GPU는 다른 종류의 일꾼이다

CPU와 GPU는 둘 다 계산을 하지만, 설계 목표가 정반대입니다.

**CPU**는 코어 하나하나가 똑똑하고 빠릅니다. 분기 예측, 거대한 캐시, 높은 클럭으로 **하나의 작업을 최대한 빨리 끝내는 것(지연, latency)** 에 최적화돼 있습니다. 대신 코어 수가 적습니다(보통 수~수십 개).

**GPU**는 반대입니다. 코어 하나는 단순하고 느리지만, 그런 코어를 **수천 개** 깔아서 **같은 연산을 엄청나게 많은 데이터에 동시에(처리량, throughput)** 적용하는 데 최적화돼 있습니다.

| | CPU | GPU |
|---|---|---|
| 최적화 목표 | 지연(latency) — 한 작업을 빨리 | 처리량(throughput) — 많은 작업을 한꺼번에 |
| 코어 | 적고 똑똑함 (수~수십 개) | 많고 단순함 (수천 개) |
| 잘하는 일 | 분기 많은 순차 로직 | 같은 연산의 대규모 병렬 (행렬곱 등) |

LLM의 핵심 연산은 거대한 **행렬곱**입니다. 수백만 개의 곱셈을 동시에 하는 일이라 GPU의 "단순한 코어 수천 개" 구조와 정확히 맞아떨어집니다.

이 대규모 병렬을 GPU가 다루는 방식을 **SIMT(Single Instruction, Multiple Thread)** 라고 합니다. **하나의 명령을 여러 스레드가 같은 데이터 묶음에 동시에 실행**한다는 뜻입니다. GPU는 스레드를 **워프(warp)**, 즉 32개 묶음 단위로 실행하는데, 한 워프 안의 32개 스레드는 같은 명령을 함께 수행합니다 ([NVIDIA CUDA C++ Programming Guide](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#hardware-model)).

## 2. SM — GPU 안의 작은 공장

GPU를 열어보면 **SM(Streaming Multiprocessor)** 이라는 단위가 수십~수백 개 들어 있습니다. SM은 **GPU 안의 작은 공장**이라고 보면 됩니다. GPU 전체는 이 공장들의 집합이고, 실제 계산은 각 SM 안에서 일어납니다.

SM 하나에는 보통 다음이 들어 있습니다.

- **CUDA 코어** — 가장 기본적인 산술 유닛. 부동소수점 곱셈-덧셈(FMA, fused multiply-add)을 하나씩 처리하는 스칼라 일꾼입니다.
- **텐서코어(Tensor Core)** — 행렬곱 전용 유닛. 다음 절의 주인공입니다.
- **워프 스케줄러, 레지스터 파일, 공유 메모리(shared memory), L1 캐시** — 스레드들에게 일을 분배하고 데이터를 가까이 두는 장치들.

보통 SM은 4개의 **서브파티션(subpartition)** 으로 나뉘고, 각 서브파티션이 자체 워프 스케줄러와 텐서코어를 하나씩 가집니다 ([How To Scale Your Model — GPUs](https://jax-ml.github.io/scaling-book/gpus/)). GPU의 연산 능력은 결국 "SM이 몇 개냐 × SM 하나가 얼마나 일하느냐"로 정해집니다.

1편에서 말한 memory-bound 이야기를 떠올리면, 디코딩 단계에서는 이 수천 개의 코어가 한가하게 놀고 메모리 대역폭만 발목을 잡습니다 (이 부분은 [LLM 추론의 Memory-Bound 특성]({% post_url 2026-01-11-llm-inference-memory-bound %})에서 다뤘습니다). 그래서 양자화로 옮길 바이트를 줄이는 게 효과가 컸던 것이고, 이번 편의 텐서코어 이야기는 그 위에 **연산 자체도 빠르게** 만드는 층을 얹는 일입니다.

## 3. 텐서코어 — 행렬곱을 통째로 처리하는 유닛

CUDA 코어가 곱셈을 하나씩 처리하는 일꾼이라면, **텐서코어는 작은 행렬곱-누산(MMA, Matrix Multiply-Accumulate)을 명령 하나로 처리**하는 특수 유닛입니다. MMA는 `D = A × B + C` 형태로, 작은 행렬 A와 B를 곱한 뒤 C를 더하는 연산입니다. 행렬곱은 결국 이 작은 MMA를 무수히 쌓아 만드는 것이라, 이걸 한 번에 처리하는 유닛이 있으면 행렬곱 전체가 훨씬 빨라집니다 ([NVIDIA Tensor Cores](https://www.nvidia.com/en-us/data-center/tensor-cores/)).

텐서코어의 역사는 **세대가 올라갈수록 더 낮은 정밀도를 지원하는 방향**으로 흘러왔습니다. 정밀도가 낮을수록 한 번에 더 많은 숫자를 처리할 수 있어 처리량이 올라가기 때문입니다.

| 세대 | 아키텍처 | 새로 추가된 주요 지원 타입 |
|------|----------|----------------------------|
| 1세대 | Volta | FP16 |
| 2세대 | Turing | INT8, INT4 |
| 3세대 | Ampere | TF32, BF16 |
| 4세대 | Hopper | **FP8** (Transformer Engine) |
| 5세대 | **Blackwell** | **FP4 / FP6** (NVFP4) |

표의 마지막 줄이 이 시리즈의 무대입니다. **Blackwell의 5세대 텐서코어는 FP4를 실리콘에서 직접 계산**합니다 ([NVIDIA Blackwell Architecture](https://www.nvidia.com/en-us/data-center/technologies/blackwell-architecture/)). 1편에서 본 NVFP4의 블록 FP8 스케일과 글로벌 FP32 스케일도 이 텐서코어가 하드웨어 차원에서 처리하도록 설계돼 있습니다.

## 4. native FP4 vs 에뮬레이션 — 같은 4비트, 다른 결말

여기가 이번 편에서 가장 중요한 지점입니다. **"4비트 가중치"를 쓴다고 해서 모두 같은 속도를 내는 게 아닙니다.** 텐서코어가 FP4를 직접 계산할 수 있느냐에 따라 결과가 갈립니다.

![native FP4와 에뮬레이션(W4A16)의 데이터 경로 비교 — native는 FP4를 텐서코어가 직접 계산, 에뮬레이션은 FP16으로 펴서 계산](/assets/images/posts/nvfp4/native-vs-emulation.svg)

**에뮬레이션 경로 (Blackwell 이전 세대 — Ampere · Ada · Hopper)**

이 세대들의 텐서코어에는 FP4 연산 경로가 없습니다. 그래서 4비트로 저장한 가중치를 행렬곱 직전에 **FP16/BF16으로 다시 펴서(dequantize)** 계산합니다. 이른바 **W4A16**(가중치 4비트, 활성값 16비트) 방식으로, AWQ·GPTQ·Marlin 같은 커널이 여기에 해당합니다. 곱셈 자체는 16비트로 도는 셈입니다 ([Baseten — 4-bit quantization](https://www.baseten.co/blog/four-bits/), [TensorRT-LLM Numerical Precision](https://nvidia.github.io/TensorRT-LLM/reference/precision.html)).

여기서 엔지니어가 정확히 구분해야 할 게 있습니다.

- **메모리 이득은 그대로 남습니다.** 어차피 메모리에서 옮길 때는 4비트라, 디코딩(memory-bound)에서는 여전히 빨라집니다. 7B AWQ 모델이 3B FP16보다 빠를 수 있는 이유가 바로 이것입니다 (→ [AWQ 양자화: 7B 모델이 3B보다 빠른 이유]({% post_url 2026-01-11-awq-quantization-performance %})).
- **연산 이득은 못 챙깁니다.** 곱셈은 16비트로 돌고, 거기에 펴는(dequantize) 비용까지 더해집니다. 그래서 연산이 병목인 구간(prefill, 큰 배치)에서는 4비트로 내린 보람이 연산 쪽에는 거의 없습니다.

**native 경로 (Blackwell 5세대 텐서코어)**

Blackwell에서는 텐서코어가 FP4 입력을 **펴지 않고 그대로 받아 하드웨어에서 곱합니다.** 블록 FP8 스케일을 곱해 복원하는 과정과 FP32 누산까지 텐서코어 안에서 처리합니다. 그 결과 **메모리 이득과 연산 이득을 둘 다** 가져갑니다. NVFP4가 "Blackwell 세대에서만 진짜 빠르다"고 말하는 이유가 이것입니다.

결국 같은 NVFP4 가중치라도 **옛 GPU에 올리면 메모리만 절약**되고, **Blackwell에 올려야 연산까지 빨라집니다.**

## 5. SM100 vs SM120 — 같은 Blackwell, 다른 무대

그런데 "Blackwell"이라고 다 같은 Blackwell이 아닙니다. NVIDIA는 GPU의 아키텍처 세대를 **compute capability**(줄여서 CC, 컴파일 타깃으로는 `sm_XX`)라는 번호로 구분하는데, Blackwell은 크게 두 갈래로 나뉩니다.

| | **SM100** (데이터센터 Blackwell) | **SM120** (소비자·워크스테이션 Blackwell) |
|---|---|---|
| compute capability | 10.0 (`sm_100`) | 12.0 (`sm_120`) |
| 대표 제품 | B200, B100, GB200 | RTX 5090 / 5080 / **5070 Ti**, RTX PRO Blackwell |
| 메모리 | HBM3e (대용량·초고대역폭) | GDDR7 |
| 텐서코어 | 5세대, native FP4 | 5세대, native FP4 |
| 주 용도 | 대규모 프로덕션 서빙·학습 | 워크스테이션·로컬 추론·개발 |

출처: [NVIDIA CUDA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus), [CUDA Toolkit 문서](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#compute-capabilities).

두 갈래 **모두 5세대 텐서코어를 갖고 있어 native FP4 자체는 지원**합니다. 우리의 실습 무대인 RTX 5070 Ti는 SM120, 즉 소비자 Blackwell입니다. 그러니 하드웨어만 보면 5070 Ti도 NVFP4를 native로 계산할 수 있어야 합니다.

문제는 하드웨어가 할 수 있다는 것과, 그 능력을 실제로 끌어 쓰는 **소프트웨어(커널)가 내 SM 타깃용으로 준비돼 있다는 것**은 별개라는 점입니다. 같은 native FP4 실리콘이라도, `sm_100`용으로 빌드·튜닝된 커널은 풍부한데 `sm_120`용은 그렇지 못한 경우가 생깁니다. 그러면 하드웨어는 멀쩡한데도 프레임워크가 native 경로 대신 4절의 에뮬레이션 경로(예: Marlin)로 빠지기도 합니다. 이 함정은 4편 실측에서 직접 로그로 확인합니다.

## 마치며

이번 편에서 쌓은 내용을 짚어보겠습니다.

- GPU는 **단순한 코어 수천 개**로 처리량을 내는 일꾼이고, 실제 계산은 **SM**이라는 공장 단위에서 일어남
- **텐서코어**는 작은 행렬곱-누산(MMA)을 명령 하나로 처리하는 유닛이고, 세대가 오를수록 더 낮은 정밀도를 지원 — **5세대 Blackwell이 FP4를 native로 계산**
- 같은 4비트라도 **native(Blackwell)는 메모리+연산 둘 다**, **에뮬레이션(옛 세대)은 메모리만** 이득
- Blackwell은 **SM100(데이터센터)** 과 **SM120(소비자, 5070 Ti 포함)** 으로 갈리는데, 둘 다 native FP4 하드웨어는 있음

그렇다면 한 가지 질문이 남습니다. **하드웨어가 native FP4를 할 수 있어도, 그걸 실제로 호출하는 "커널"이 없으면 어떻게 될까요?** 그리고 vLLM은 내 GPU와 모델 포맷을 보고 어떤 커널을 고를까요?

다음 글(소프트웨어 편)에서 **커널이 무엇인지**, 그리고 vLLM이 양자화 가중치를 받아 **어떤 백엔드를 선택해 forward를 도는지** 그 디스패치 체인을 따라가 보겠습니다.

## 참고 자료

- NVIDIA. *NVIDIA Tensor Cores*. [nvidia.com](https://www.nvidia.com/en-us/data-center/tensor-cores/) — 텐서코어와 MMA 개요
- NVIDIA. *NVIDIA Blackwell Architecture*. [nvidia.com](https://www.nvidia.com/en-us/data-center/technologies/blackwell-architecture/) — 5세대 텐서코어, FP4/FP6 지원
- NVIDIA. *RTX PRO Blackwell GPU Architecture Whitepaper (v1.0)*. [PDF](https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1.0.pdf) — 소비자·워크스테이션 Blackwell의 5세대 텐서코어와 FP4
- NVIDIA. *CUDA C++ Programming Guide — Hardware Model & Compute Capabilities*. [docs.nvidia.com](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#hardware-model) — SM, SIMT, compute capability
- NVIDIA. *CUDA GPUs — Compute Capability*. [developer.nvidia.com](https://developer.nvidia.com/cuda-gpus) — 제품별 CC(`sm_100`, `sm_120`) 매핑
- NVIDIA. *TensorRT Unlocks FP4 Image Generation for GeForce RTX 50 Series*. [NVIDIA Developer Blog](https://developer.nvidia.com/blog/nvidia-tensorrt-unlocks-fp4-image-generation-for-nvidia-blackwell-geforce-rtx-50-series-gpus/) — 소비자 Blackwell의 native FP4 활용
- Baseten. *4-bit Quantization for Inference Optimization*. [baseten.co](https://www.baseten.co/blog/four-bits/) — W4A16(저장 4비트 + FP16 dequant) 동작
- NVIDIA. *TensorRT-LLM — Numerical Precision*. [nvidia.github.io](https://nvidia.github.io/TensorRT-LLM/reference/precision.html) — W4A16 등 정밀도 조합
