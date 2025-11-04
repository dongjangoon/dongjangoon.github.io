---
layout: single
title: "KV 캐싱과 GPU 병렬화 - LLM 추론"
date: 2025-11-04 22:30:00 +0900
categories: ai
tags: [llm, ai, KV Cache, GPU]
excerpt: "LLM 추론 최적화에서 중요한 KV 캐싱과 GPU 병렬화의 내용입니다."
---

### KV(키-값) 캐싱

- 입력/컨텍스트 토큰이 한번만 계산되어 각 레이어에서 Key, Value 벡터를 저장
- 디코딩(토큰 생성)에서 저장된 KV를 로드하여 새로 생성된 토큰만 계산
- attention 메커니즘에서 중복된 연산을 수행하는 대신 KV 값들을 계산하고 한번만 저장
- 예를 들어, N개 토큰 입력 시 첫번째 토큰은 앞선 (N-1)개 토큰과의 조합을 일일이 계산해야 함

### KV 캐시 메모리 계산

```
# KV 캐시 메모리 = seq_len * hidden_size * num_layers * 2 * 2
# 2 = K,V, 2 = fp16

# 예시: LLaMA-7B
hidden_size = 4096
num_layers = 32
seq_len = 2048

kv_cache_size = 2048 * 4096 * 32 * 2 * 2 bytes = 1GB (시퀀스 하나당)
```

### 레이어별 KV 저장
```
# 각 레이어마다 독립적인 KV 캐시 필요
Layer 0: K[seq_len, hidden_size], V[seq_len, hidden_size]
Layer 1: K[seq_len, hidden_size], V[seq_len, hidden_size]
...
Layer 31: K[seq_len, hidden_size], V[seq_len, hidden_size]

# 총 32개 레이어 * 2(K, V) = 64개의 캐시 텐서
```

### 메모리 최적화의 핵심
```
total_memory = kv_cache_size * max_num_seqs
```

### 여러 GPU를 사용할 때 속도가 빨라지는 이유

현대 LLM은 수십억에서 수조 개의 파라미터를 갖고 있습니다. 이런 거대한 모델을 효율적으로 처리하기 위해 병렬 처리 방식을 사용합니다.

**1. 모델 병렬화 (Model Parallelism)**
- 거대한 모델 파라미터를 여러 GPU에 나누어 저장하고 계산
- 각 GPU는 모델의 일부분만 담당

**2. 데이터 병렬화 (Data Parallelism)**
- 동일한 모델을 여러 GPU에 복제하고, 각 GPU는 다른 데이터 배치를 처리

**3. 텐서 병렬화 (Tensor Parallelism)**
- 특정 연산(예: 행렬 곱셈)을 여러 GPU에 분산시켜 병렬로 처리

**4. 메모리 대역폭 증가**
- 각 GPU는 자체 메모리와 대역폭을 가지며, 이론적으로 2개의 GPU는 대역폭이 2배로 증가

### TTFT 감소에도 도움이 되는 이유

**1. KV 캐시 초기화 가속화**
- 첫 토큰을 생성하기 전에 모델은 모든 컨텍스트 KV 캐시를 초기화하고 입력 프롬프트를 처리해야 함
- 여러 GPU에 이 작업을 분산하면 초기 처리속도가 빨라짐

**2. 프롬프트 처리 병렬화**
- 입력 프롬프트의 토큰들을 병렬로 처리할 수 있음
- 여러 GPU에 이 작업을 분산하면 초기 처리속도가 빨라짐

**3. 모델 레이어 병렬 처리**
- 프롬프트의 각 레이어 계산을 병렬로 처리
- 각 레이어의 계산이 동시에 이루어짐

**4. 행렬 연산 가속화**
- 첫 토큰 생성에 필요한 대규모 행렬 연산을 더 빠르게 처리할 수 있고, 이로 인해 초기 지연 시간을 줄임