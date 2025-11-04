---
layout: single
title: "Transformer를 사용한 추론 과정 분석"
date: 2025-11-04 22:30:00 +0900
categories: ai
tags: [llm, ai, transformer]
excerpt: "LLM 모델을 추론 과정에서 사용할 때, transformer 모델에서 일어나는 과정을 정리했습니다."
---

### 모델 추론 방향성

> Tokenizer(CPU) → Embedding Layer + Positional Encoding (GPU 병렬 처리 대상 아님) → Transformer Block * N → Output Layer

**Positional Encoding**
- Transformer 모델에서 시퀀스 내 토큰들의 위치 정보 제공
- Self-attention은 입력 시퀀스의 모든 토큰을 동시 처리하고 순서 정보가 없음
- 따라서 토큰 임베딩에 각 토큰의 위치 인코딩 정보를 더해줌

### Transformer Block에서의 방향성

> LayerNorm1 → Multi-Head Self-Attention → Residual connection + Add → LayerNorm2 → FeedForward Neural Network → Residual connection + Add

**LayerNorm**: 입력 분포 정규화

**MHSA (Multi-Head Self-Attention)**: 토큰이 문맥(context) 안에서 다른 토큰과 관련성을 개선

0. Linear: Q, K, V (각각 연산)
1. 헤드 분할 (N개의 어텐션 헤드를 GPU 개수에 맞게 분할), 헤드별로 Q, K, V 투영
   - 이 과정에서 신규 K, V 값 KV 캐시에 저장
2. 어텐션 점수 계산 (Q * K^T / d^1/2) * V
   - 이 과정에서 KV Load
3. 각 GPU에서 계산된 헤드 결과를 AllGather나 Concat으로 합산
4. 출력 투영 (O) 후, AllReduce

**Residual connection + Add**: Attention 결과로 생성된 문맥 정보를 합침

**FFN (FeedForward Neural Network)**
1. Linear1 (임베딩 차원 확장, 행렬 곱셈)
2. Activation (GELU, ReLU)
3. Linear2 (임베딩 차원 축소, 행렬 곱셈)
4. AllReduce - 선택적 (tensor parallelism, 열 기준으로 분할해서 각 GPU가 위 행렬 계산을 진행함, AllReduce는 이 결과들을 합산)

### Output Layer

- Linear Projection
- 텐서 병렬화로 분할되어 있던 vocab들이 AllGather 연산으로 합쳐짐
- **Softmax** (다음 토큰 확률 분포 계산)
- **Argmax** (가장 높은 확률 선택)

→ **"첫 출력 토큰 생성"**

### Prefill (질의 의미(의도) 파악)

- 위 과정이 Prefill 과정 동안 진행됨
- 이를 통해 생성된 첫 출력 토큰이 다음 트랜스포머 블록의 입력값으로 들어감

### Decode (모델 답변, 토큰 반복 생성)

- 같은 과정이 Transformer 블록 내에서 일어나지만, MHSA의 초반 과정에서 조금 다름
- 처음에 Linear Q만 연산
- Head 분할 (Q에 대해서만)
