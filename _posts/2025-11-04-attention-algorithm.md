---
layout: single
title: "Attention 알고리즘에 대해서"
date: 2025-11-04 22:30:00 +0900
categories: ai
tags: [llm, ai, attention]
excerpt: "LLM의 핵심 뼈대인 Attention 알고리즘에 대한 내용입니다."
---

### Attention 메커니즘이란?

어떤 정보에 **주목**해야 할지 자동으로 학습하는 메커니즘입니다.

### Q, K, V의 의미

**Query(Q) - 질문**
```
# 지금 무엇을 찾고 있는가?
query = "고양이는"  # 현재 처리하려는 토큰
-> 고양이와 관련된 정보를 찾고 싶다
```

**Key(K) - 색인**
```
# 각 위치가 어떤 정보를 담고 있는가?
keys = ["동물", "털복숭이", "야옹", "집", "사료"]  # 각 토큰의 특징
-> 각 위치의 주제 또는 특성
```

**Value(V) - 실제 내용**
```
# 실제로 전달할 정보는 무엇인가?
values = [동물_정보, 털_정보, 소리_정보, 장소_정보, 음식_정보]  # 실제 의미
-> 각 위치의 "실제 내용"
```

### Attention 계산 과정

**1. 유사도 계산**
```
# Query와 Key 간의 유사도 (내적)
scores = Q @ K.T  # Q와 각 K의 유사도
-> "고양이는"이 ["동물", "털복숭이", "야옹"] 중 어디에 주목해야 할까
```

**2. 확률 변환**
```
# Softmax로 확률 분포 생성
attention_weights = softmax(scores / sqrt(d_k))
-> [0.1, 0.3, 0.6] -> "야옹"에 60% 주목
```

**3. 정보 추출**
```
# 가중합으로 최종 출력
output = attention_weights @ V
-> 0.1 * 동물_정보 + 0.3 * 털_정보 + 0.6 * 소리_정보
```

### Multi-Head Attention
```
# 여러 개의 attention을 병렬로 수행
head_1: 문법적 관계에 주목  # 주어-동사
head_2: 의미적 관계에 주목  # 고양이-야옹
head_3: 위치적 관계에 주목  # 인접한 토큰들
```

**모든 head 결과를 결합**
```
final_output = concat(head_1, head_2, head_3) @ W_o
```

- **head**: Attention을 여러 개의 독립적인 관점으로 나누어 처리하는 단위

### Self-Attention vs Cross-Attention

**Self-Attention (같은 시퀀스 간)**
```
Q, K, V = 모두 같은 입력 문장에서 생성
```

**Cross-Attention (다른 시퀀스 간)**
```
Q = 디코더 (번역할 문장)
K, V = 인코더 (원본 문장)
```