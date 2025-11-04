---
layout: single
title: "vllm과 pagedAttention"
date: 2025-11-04 22:30:00 +0900
categories: ai
tags: [llm, ai, vllm]
excerpt: "vllm과 pagedAttention에 대해 간략하게 정리한 내용입니다."
---

### vLLM이란?

LLM 모델 추론과 서빙에 사용하는 오픈소스 라이브러리입니다.

### 문제점

- LLM 서빙의 주요 병목은 메모리에서 발생
- autoregressive decoding 과정에서 LLM의 input token들은 attention key, value 텐서를 생성
- 이 텐서들은 다음 토큰을 생성하기 위해 GPU 메모리에 저장됨 → KV Cache
- KV 캐시는 크고 동적이어서 fragmentation, over-reservation 등으로 메모리의 60-80% 정도를 낭비할 수 있음

### 해결: PagedAttention

- OS의 가상 메모리, 페이징에서 아이디어를 가져옴
- 질의(쿼리)가 연속적인 K, V 벡터가 될 때, 이를 동일한 개수의 토큰(바이트)를 갖는 블록 단위(페이지)로 나눠서 연속적이지 않은 메모리 공간에 저장
- 이 때문에 fragmentation이 발생하지 않고 시퀀스의 마지막 부분에서만 메모리 낭비가 발생
- 동시에 병렬 질의도 더 빠르게 할 수 있음