---
layout: single
title: "Compressed FSM과 Structured Output - 구조화된 출력의 원리와 최적화 (SGLang 시리즈 Part 3)"
date: 2026-03-27 14:00:00 +0900
categories: mlops
tags: [sglang, vllm, structured-output, constrained-decoding, json-schema, xgrammar, fsm, llm-serving]
excerpt: "LLM이 항상 올바른 JSON을 출력하도록 보장할 수 있을까요? SGLang의 Compressed FSM은 구조화된 출력을 보장하면서도, 오히려 비제약 생성보다 빠를 수 있다는 역설적인 결과를 보여줍니다. Jump-forward 최적화로 결정론적 토큰을 건너뛰고, XGrammar로 문법 검증 오버헤드를 마이크로초 단위로 줄이는 원리를 소스 코드 수준에서 분석합니다."
---

> 이 글은 **SGLang v0.5.9**, **vLLM v0.17.1**, **XGrammar 2** (2026년 1분기) 기준으로 작성되었습니다.

## 들어가며

LLM 기반 서비스를 운영하다 보면 반드시 마주치는 문제가 있습니다.

```python
# 기대한 출력
{"name": "삼성전자", "score": 85, "recommendation": "매수"}

# 실제 LLM 출력 (가끔)
물론입니다! 분석 결과를 JSON으로 정리해 드리겠습니다:
```json
{"name": "삼성전자", "score": 85, "recommendation": "매수"}
```
이 분석은...
```

LLM이 "대부분" 올바른 JSON을 출력하더라도, **가끔 형식을 벗어나면 파이프라인 전체가 실패**합니다. 후처리로 파싱을 시도하거나, 실패 시 재시도하는 방식은 근본적인 해결이 아닙니다.

**Constrained decoding(구조화 출력)**은 이 문제를 근본적으로 해결합니다. LLM이 토큰을 생성할 때마다 문법 규칙에 맞는 토큰만 선택하도록 강제하여, **구조적 정확성을 100% 보장**합니다.

SGLang은 여기서 한 걸음 더 나아갑니다. **Compressed FSM**이라는 독자적인 최적화로, 구조화된 출력이 오히려 비제약 생성보다 **빠를 수 있다**는 역설적인 결과를 달성합니다.

[Part 1]({{ site.baseurl }}{% post_url 2026-03-26-sglang-architecture-deep-dive %})에서 SGLang 아키텍처의 전체 구조를, [Part 2]({{ site.baseurl }}{% post_url 2026-03-27-sglang-radixattention-vs-pagedattention %})에서 RadixAttention의 KV cache 전략을 다뤘습니다. 이 글에서는 세 번째 핵심 혁신인 Compressed FSM과 구조화 출력 시스템을 분석합니다.

## Constrained Decoding의 기본 원리

### 토큰 마스킹

Constrained decoding의 핵심은 단순합니다. **모델이 다음 토큰을 샘플링하기 직전에, 문법적으로 허용되지 않는 토큰의 확률을 -∞로 설정**합니다.

```
일반 생성:
  logits = model(input_ids)
  next_token = sample(logits)  → 어떤 토큰이든 가능

구조화 생성:
  logits = model(input_ids)
  mask = grammar.get_allowed_tokens(current_state)  → [true, false, true, ...]
  logits[~mask] = -inf         → 허용되지 않는 토큰 차단
  next_token = sample(logits)  → 문법적으로 유효한 토큰만 선택
```

### FSM (유한 상태 머신) 기반 접근

문법 규칙을 FSM으로 변환하면, 각 상태에서 허용되는 토큰을 사전에 계산할 수 있습니다.

```
JSON 객체 {"name": "<string>"}의 FSM (단순화):

  State 0: 시작
     │ 허용: { 만
     ▼
  State 1: 키 시작
     │ 허용: " 만
     ▼
  State 2: 키 내부
     │ 허용: n, a, m, e (스키마에 따라)
     ▼
  State 3: 키 종료
     │ 허용: " 만
     ▼
  State 4: 콜론
     │ 허용: : 만
     ▼
  State 5: 값 시작
     │ 허용: " 만 (string 타입)
     ▼
  State 6: 값 내부
     │ 허용: 모든 문자 (닫는 " 제외)
     ▼
  State 7: 값 종료 + 객체 닫기
     │ 허용: } 만
     ▼
  State 8: 완료 (Accept)
```

**Outlines** 라이브러리가 이 접근법을 대중화했습니다. JSON 스키마 → 정규식 → DFA(FSM) → 토큰별 유효성 맵 사전 계산. 추론 시에는 현재 상태에서 허용되는 토큰 집합을 O(1)로 조회합니다.

### 문제: 결정론적 구간의 낭비

이 방식의 근본적인 비효율을 살펴보겠습니다.

```
JSON 스키마: {"name": "<string>", "age": <integer>}

토큰 생성 과정 (일반 FSM):
  Step 1:  모델 forward → logits → mask → sample → {         ← 결정론적 (1개 선택지)
  Step 2:  모델 forward → logits → mask → sample → "         ← 결정론적
  Step 3:  모델 forward → logits → mask → sample → name      ← 결정론적
  Step 4:  모델 forward → logits → mask → sample → "         ← 결정론적
  Step 5:  모델 forward → logits → mask → sample → :         ← 결정론적
  Step 6:  모델 forward → logits → mask → sample → " (공백+) ← 결정론적
  Step 7:  모델 forward → logits → mask → sample → 김        ← 자유 생성
  Step 8:  모델 forward → logits → mask → sample → 철        ← 자유 생성
  Step 9:  모델 forward → logits → mask → sample → 수        ← 자유 생성
  Step 10: 모델 forward → logits → mask → sample → "         ← 결정론적
  Step 11: 모델 forward → logits → mask → sample → ,         ← 결정론적
  ...

→ 결정론적 구간에서도 매번 GPU forward pass를 실행
→ 선택지가 1개뿐인데 수십억 파라미터의 연산을 수행하는 것은 순수 낭비
```

## Compressed FSM: SGLang의 핵심 혁신

### 압축 아이디어

SGLang의 Compressed FSM은 이 낭비를 정면으로 해결합니다. **단일 전이(singular transition)가 연속되는 구간을 하나의 압축 edge로 합칩니다.**

```
일반 FSM:
  S0 →{→ S1 →"→ S2 →n→ S3 →a→ S4 →m→ S5 →e→ S6 →"→ S7 →:→ S8 →"→ S9
  (각 전이마다 forward pass 필요)

Compressed FSM:
  S0 ──{"name": "──→ S9
  (하나의 압축 edge, 한 번의 prefill로 처리)
```

### 압축 알고리즘

FSM의 압축 과정을 단계별로 살펴보겠습니다.

```
입력 FSM의 각 상태를 순회:
  1. 현재 상태에서 나가는 전이가 정확히 1개인가?
  2. 그 다음 상태에서도 나가는 전이가 정확히 1개인가?
  3. 1-2가 반복되는 구간을 찾아서 하나의 edge로 합침

예: JSON 스키마 {"name": "<string>", "age": <integer>}

압축 전 상태 수: ~20개
압축 후:
  Edge A: '{"name": "'         (S0 → S9)   ← 결정론적 구간 1
  Edge B: 자유 생성 구간        (S9 → S10)  ← 모델이 실제로 생성하는 부분
  Edge C: '", "age": '         (S10 → S19) ← 결정론적 구간 2
  Edge D: 정수 생성 구간        (S19 → S20) ← [0-9]+ 제약
  Edge E: '}'                  (S20 → S21) ← 결정론적 구간 3
```

### Jump-Forward 최적화

압축 edge를 만난 시점에서 SGLang은 **Jump-forward**를 수행합니다. 모델의 forward pass 없이 결정론적 토큰들을 건너뛰고, 한 번의 prefill로 처리합니다.

```
일반 FSM 처리 (forward pass 횟수):
  {"name": "    → 6회 forward (결정론적 구간)
  김철수         → 3회 forward (자유 생성)
  ", "age":     → 6회 forward (결정론적 구간)
  25            → 2회 forward (정수 생성)
  }             → 1회 forward (결정론적)
  총: 18회 forward pass

Compressed FSM + Jump-Forward:
  {"name": "    → 1회 prefill (압축 edge 전체를 한 번에)
  김철수         → 3회 forward (자유 생성)
  ", "age":     → 1회 prefill (압축 edge)
  25            → 2회 forward (정수 생성)
  }             → 1회 prefill (압축 edge)
  총: 8회 forward/prefill

비제약 생성 (JSON 보장 없음):
  모델이 자유롭게 토큰 생성
  평균: ~15-20회 forward pass (모델에 따라 다름)

→ Compressed FSM (8회) < 비제약 생성 (15~20회)
→ 구조화 출력이 오히려 더 빠름!
```

이것이 SGLang 논문의 핵심 결과입니다. **Constrained decoding이 unconstrained generation보다 빠를 수 있다.** 결정론적 구간이 길수록 jump-forward의 이점이 커집니다.

### Retokenization 처리

Jump-forward에는 한 가지 기술적 도전이 있습니다. LLM의 토크나이저는 **문맥에 따라 같은 문자열을 다른 토큰 시퀀스로 인코딩**할 수 있습니다.

```
독립적 토큰화:
  '{"name"' → [123, 456, 789]     # 단독 토큰화

맥락 속 토큰화:
  '...결과는 {"name"' → [123, 455, 790]  # 앞 토큰의 영향으로 다른 결과
```

SGLang은 jump-forward 시 **이전 텍스트와 압축 edge 문자열을 합쳐서 재토큰화(retokenization)**합니다. 이를 통해 모델의 학습 시 토큰화 규칙과 정확히 일치하는 토큰 ID를 보장합니다. 논문에 따르면 이 retokenization의 오버헤드는 무시할 수 있는 수준입니다.

## XGrammar: 문법 백엔드

SGLang의 Compressed FSM이 "어떻게 빠르게 건너뛸 것인가"를 해결한다면, **XGrammar**는 "각 토큰의 유효성을 어떻게 빠르게 검증할 것인가"를 해결합니다. XGrammar는 SGLang(그리고 vLLM, TensorRT-LLM)의 기본 문법 백엔드입니다.

### FSM을 넘어서: Pushdown Automaton

Outlines가 사용하는 FSM(DFA)은 **정규 언어(regular language)만 처리**할 수 있습니다. 하지만 실제 JSON은 정규 언어가 아닙니다. 중첩 구조를 가지기 때문입니다.

```
정규 언어로 표현 불가능한 JSON:
{
  "items": [
    {"name": "A", "sub_items": [{"id": 1}, {"id": 2}]},
    {"name": "B", "sub_items": [{"id": 3}]}
  ]
}
→ 배열 안의 객체 안의 배열 안의 객체 (임의 깊이 중첩)
→ 문맥 자유 문법(CFG)이 필요
```

XGrammar는 **Pushdown Automaton(PDA, 푸시다운 오토마타)** 을 사용합니다. PDA는 "스택이 있는 FSM"으로, 중첩 구조를 스택으로 추적합니다.

```
PDA 동작 예시:
  "{" → 스택 push: OBJECT          현재 상태: 객체 내부
  "[" → 스택 push: ARRAY           현재 상태: 배열 내부
  "{" → 스택 push: OBJECT          현재 상태: 중첩 객체 내부
  "}" → 스택 pop: OBJECT           현재 상태: 배열 내부로 복귀
  "]" → 스택 pop: ARRAY            현재 상태: 객체 내부로 복귀
  "}" → 스택 pop: OBJECT           현재 상태: 최상위로 복귀
```

### 2-Tier 토큰 검증

XGrammar의 핵심 최적화는 **토큰을 두 계층으로 분류**하는 것입니다.

```
전체 어휘 (vocabulary, ~128,000 토큰)
├── Context-Independent 토큰 (~99%)
│   → 현재 PDA 상태만으로 유효성 결정 가능
│   → 사전 계산된 비트마스크로 O(1) 조회
│
└── Context-Dependent 토큰 (~1%)
    → 스택 정보까지 필요 (중첩 깊이에 따라 달라짐)
    → 런타임에 개별 검증
```

이 분류 덕분에 전체 어휘의 99%는 사전 계산된 캐시에서 즉시 조회되고, 나머지 1%만 런타임에 검증합니다. 토큰 마스크 생성에 걸리는 시간은 **40마이크로초 미만**입니다.

### XGrammar 2: 에이전트 워크로드 대응

2025년 1월에 발표된 XGrammar 2는 **동적 문법 전환**이 빈번한 에이전트 워크로드를 위해 설계되었습니다.

**TagDispatch 메커니즘**

```
모델 출력 (자유 생성):
  "분석 결과를 정리하면..."

  "계산이 필요합니다. <function=calculator>"
                       ↑ 태그 감지 (Aho-Corasick 매칭)

모드 전환: 자유 생성 → 구조화 생성
  '{"expression": "125 * 0.85", "precision": 2}'
                                              ↑ 구조 완료

모드 복귀: 구조화 생성 → 자유 생성
  "계산 결과 106.25원입니다..."
```

이 메커니즘은 **Dispatching 모드**(자유 생성 중 태그 패턴 모니터링)와 **Dispatched 모드**(태그 감지 후 문법 제약 적용) 사이를 자동으로 전환합니다. 금융 서비스에서 LLM이 분석 텍스트를 생성하다가 API 호출이 필요한 시점에 정확한 JSON 파라미터를 생성하는 패턴에 직접 적용됩니다.

**JIT 컴파일**

XGrammar 1은 모든 문법 상태의 토큰 마스크를 사전 계산했습니다. XGrammar 2는 **JIT(Just-In-Time) 컴파일**로 전환했습니다.

```
XGrammar 1:
  서버 시작 → 모든 상태의 토큰 마스크 사전 계산 (0.12~0.30초)
  → 문법이 많으면 시작 시간 증가

XGrammar 2:
  서버 시작 → 최소한의 초기화 (~0.01초)
  요청 도착 → 필요한 상태만 JIT 컴파일
            → 캐시 풀에 저장
            → 다음 요청에서 캐시 히트
  → 100배 빠른 문법 컴파일
```

**Cross-Grammar 캐싱**

서로 다른 JSON 스키마라도 내부적으로 공통 하위 구조를 공유하는 경우가 많습니다. XGrammar 2는 FSM 구조를 해싱하여 이를 자동으로 감지하고 재활용합니다.

```
스키마 A: {"name": string, "age": integer}
스키마 B: {"title": string, "count": integer}

→ string 처리 FSM과 integer 처리 FSM은 동일
→ 토큰 마스크 캐시를 공유
```

## RadixAttention과의 시너지

Compressed FSM과 RadixAttention은 서로 다른 계층에서 동작하지만, 결합 시 시너지가 발생합니다.

### Prefix 캐시 + 문법 캐시의 이중 재활용

```
요청 1: System Prompt + "삼성전자 분석" → JSON 스키마 A
요청 2: System Prompt + "LG전자 분석"  → JSON 스키마 A (동일)
요청 3: System Prompt + "SK하이닉스"   → JSON 스키마 A (동일)

RadixAttention 효과:
  요청 1: System Prompt의 KV cache 계산 (캐시 미스)
  요청 2: System Prompt의 KV cache 재활용 (캐시 히트) → prefill 절약
  요청 3: 동일하게 캐시 히트

XGrammar 캐시 효과:
  요청 1: JSON 스키마 A의 PDA + 토큰 마스크 컴파일
  요청 2: 컴파일된 문법 재활용 (캐시 히트) → 컴파일 비용 0
  요청 3: 동일하게 캐시 히트

결합 효과:
  요청 2, 3에서는 prompt의 KV cache도, 문법 컴파일도 모두 캐시 히트
  → 실질적으로 "새로운 쿼리 부분의 prefill + 자유 생성 토큰"만 GPU 연산
```

### Overlap Scheduling과의 통합

[Part 1]({{ site.baseurl }}{% post_url 2026-03-26-sglang-architecture-deep-dive %})에서 다룬 Overlap Scheduling은 문법 처리도 GPU 실행과 병렬화합니다.

```
GPU: [배치 N forward pass 실행 중...]
CPU: [배치 N+1 준비]
     ├─ RadixCache prefix matching (KV 캐시 히트 확인)
     ├─ XGrammar 토큰 마스크 계산 (다음 step의 문법 제약)
     ├─ 메모리 할당
     └─ 배치 메타데이터 구성

→ 문법 검증의 CPU 오버헤드가 GPU 실행 시간 뒤에 완전히 숨겨짐
```

## vLLM의 Structured Output 접근법

### 아키텍처 차이

vLLM도 XGrammar를 기본 문법 백엔드로 사용합니다. 하지만 **아키텍처적 통합 방식**에서 차이가 있습니다.

```
vLLM의 구조화 출력 처리:
  GPU forward → logits 생성 → [문법 마스크 적용] → 샘플링
                                ↑
                          Critical Path에 위치
                          배치 내 하나라도 구조화 출력이면
                          전체 배치가 대기

SGLang의 구조화 출력 처리:
  GPU: [배치 N forward]     [배치 N+1 forward]
  CPU:    [배치 N+1 문법 마스크 사전 계산]
          ↑
        GPU 실행과 병렬 처리
        Critical Path에서 분리
```

이 차이로 인해 **동시 요청 수(concurrency)가 증가할수록 성능 격차가 벌어집니다.** vLLM은 배치 크기 8 이상에서 구조화 출력의 오버헤드가 눈에 띄게 증가하지만, SGLang은 비교적 일정한 오버헤드를 유지합니다.

### 문법 백엔드 지원 비교

| 기능 | SGLang v0.5.9 | vLLM v0.17.1 |
|------|--------------|-------------|
| **XGrammar** | 기본 | 기본 |
| **Outlines** | 레거시 지원 | 폴백 |
| **LLGuidance** | `--grammar-backend llguidance` | 선택적 |
| **JSON Schema** | 직접 지원 | 직접 지원 |
| **Regex** | `sgl.gen(regex="...")` | `guided_decoding` 파라미터 |
| **EBNF 문법** | 직접 지원 | XGrammar 경유 |
| **Reasoning 모델 + 구조화 출력** | `--reasoning-parser` 플래그 | 지원 |
| **TagDispatch (XGrammar 2)** | 통합 | 부분 지원 |

### Reasoning 모델과 구조화 출력

DeepSeek-R1, QwQ 같은 reasoning 모델은 `<think>...</think>` 블록에서 자유롭게 사고한 뒤 최종 답변을 구조화합니다. SGLang은 이를 명시적으로 지원합니다.

```
모델 출력 흐름:
  <think>
    삼성전자의 2024년 영업이익은... PER을 고려하면...
    목표가는 85,000원 수준이 적정한데...
  </think>
  ← 여기서부터 JSON 스키마 제약 적용
  {"company": "삼성전자", "target_price": 85000, "rating": "매수"}
```

`--reasoning-parser` 플래그로 thinking 구간에서는 문법 제약을 비활성화하고, 최종 출력에서만 제약을 적용합니다. 이를 통해 모델의 추론 능력을 유지하면서도 출력 형식을 보장합니다.

## 벤치마크

### 구조화 출력의 정확성 향상

구조화 출력은 단순히 형식만 보장하는 것이 아니라, **태스크 성능 자체를 향상**시킵니다.

| 태스크 | 비제약 생성 | 구조화 생성 | 향상폭 |
|--------|-----------|-----------|--------|
| Last Letter | 50.7% | 54.0% | +3.3% |
| Shuffle Objects | 52.6% | 55.9% | +3.3% |
| GSM-8K (수학) | 80.1% | 83.8% | +3.7% |

형식 제약이 모델의 "집중"을 돕는 것으로 해석됩니다.

### SGLang 논문 벤치마크

Compressed FSM의 단독 기여를 측정한 ablation study 결과입니다.

| 최적화 | 처리량 향상 |
|--------|-----------|
| RadixAttention만 | 기준 |
| + Compressed FSM | **+1.6x** |
| + 전체 최적화 (RadixAttention + FSM + Overlap) | **최대 6.4x** |

### SGLang vs vLLM: 구조화 출력 성능 (SqueezeBits 벤치마크)

**반복 스키마 (Book-Info 데이터셋, 동일 스키마 반복)**

| 엔진 + 백엔드 | 정확성 | 동시성 8에서의 성능 |
|--------------|--------|-----------------|
| SGLang + XGrammar | **100%** | 안정적 |
| vLLM + XGrammar | **100%** | 배치 ≥ 8에서 성능 하락 |
| 비제약 생성 | ≤ 72% | - |

반복 스키마에서는 XGrammar의 캐싱이 효과적이어서 SGLang, vLLM 모두 좋은 성능을 보입니다. 다만 동시성이 높아지면 SGLang의 overlap 처리가 유리합니다.

**동적 스키마 (GitHub_easy, 매 요청마다 다른 스키마)**

| 엔진 + 백엔드 | 정확성 | 비고 |
|--------------|--------|------|
| SGLang + LLGuidance | **98.2%** | 동적 스키마에서 안정적 |
| SGLang + XGrammar | ~96% | 캐싱 이점 감소, 간헐적 CPU 병목 |
| vLLM + XGrammar | ~94% | 동적 스키마에서 더 큰 오버헤드 |

동적 스키마에서는 캐시 히트가 줄어들어 **LLGuidance**(Rust 기반, 토큰당 ~50μs)가 XGrammar보다 안정적인 성능을 보입니다.

### 문법 컴파일 시간 비교

| 엔진 | 컴파일 시간 | 특징 |
|------|-----------|------|
| XGrammar 2 (JIT) | **~0.01초** | JIT + cross-grammar 캐싱 |
| LLGuidance | **~0.01초** | Rust 네이티브 |
| llama.cpp | 0.05~0.06초 | C++ |
| XGrammar 1 | 0.12~0.30초 | 사전 컴파일 |
| Outlines | 3.48~8.05초 | Python, 대규모 어휘에서 느림 |

### JSON 스키마 커버리지 (JSONSchemaBench, 9,558개 실제 스키마)

| 엔진 | GlaiveAI | GitHub Easy | GitHub Medium | Kubernetes |
|------|----------|-------------|---------------|------------|
| Guidance | **0.96** | **0.86** | **0.69** | **0.91** |
| llama.cpp | 0.95 | 0.75 | 0.57 | 0.76 |
| XGrammar 1 | 0.93 | 0.79 | 0.52 | 0.07 |
| Outlines | 0.95 | 0.59 | 0.29 | 0.57 |

Kubernetes CRD 같은 복잡한 스키마에서 XGrammar 1의 커버리지가 낮은 점은 주목할 만합니다. XGrammar 2와 LLGuidance가 이 갭을 줄이고 있으며, SGLang에서는 `--grammar-backend` 플래그로 워크로드에 맞는 백엔드를 선택할 수 있습니다.

## 실전 활용: 금융 도메인 예시

### 종목 분석 리포트 생성

```python
from openai import OpenAI
from pydantic import BaseModel

class StockAnalysis(BaseModel):
    company: str
    sector: str
    current_price: int
    target_price: int
    rating: str  # "매수", "보유", "매도"
    key_factors: list[str]
    risk_factors: list[str]

client = OpenAI(base_url="http://localhost:30000/v1", api_key="EMPTY")

response = client.chat.completions.create(
    model="meta-llama/Llama-3.1-70B-Instruct",
    messages=[
        {"role": "system", "content": "당신은 증권 애널리스트입니다."},
        {"role": "user", "content": "삼성전자 투자 의견을 작성해주세요."}
    ],
    response_format={
        "type": "json_schema",
        "json_schema": {
            "name": "stock_analysis",
            "schema": StockAnalysis.model_json_schema()
        }
    }
)
# 100% 유효한 JSON 보장, 파싱 실패 없음
analysis = StockAnalysis.model_validate_json(response.choices[0].message.content)
```

### 대량 배치 처리에서의 이점

수백 건의 종목 분석을 동일한 스키마로 요청할 때, SGLang의 이점이 극대화됩니다.

```
500건의 종목 분석 요청 (동일 system prompt + 동일 JSON 스키마):

RadixAttention 효과:
  → System prompt KV cache: 1번 계산, 499번 재활용

XGrammar 캐시 효과:
  → StockAnalysis 스키마 컴파일: 1번, 499번 재활용

Compressed FSM 효과:
  → JSON 구조 토큰 (~40%): jump-forward로 건너뜀
  → 실제 GPU 연산: 자유 생성 토큰 (~60%)에만 집중

DFS_WEIGHT 스케줄링:
  → 동일 prefix를 공유하는 요청들을 연속 배치
  → 캐시 히트율 극대화
```

## 마무리

이 글에서 분석한 핵심을 정리하면 다음과 같습니다.

- **Compressed FSM**은 결정론적 토큰 구간을 압축하여 jump-forward로 건너뜁니다. 구조화 출력이 비제약 생성보다 빠를 수 있는 역설적 결과를 만들어냅니다.
- **XGrammar**는 pushdown automaton 기반의 문법 백엔드로, 2-tier 토큰 검증을 통해 어휘의 99%를 사전 계산된 캐시로 처리합니다.
- **XGrammar 2**는 TagDispatch와 JIT 컴파일로 에이전트 워크로드와 동적 문법 전환을 지원합니다.
- SGLang은 Overlap Scheduling으로 문법 검증을 GPU 실행과 병렬화하여, 동시성이 높아져도 안정적인 성능을 유지합니다.
- RadixAttention + XGrammar 캐시의 조합은 **KV cache와 문법 컴파일을 동시에 재활용**하여, 동일 스키마 대량 요청에서 극적인 효율 향상을 제공합니다.

다음 **Part 4**에서는 SGLang을 **대규모 GPU 클러스터에서 운영**하는 방법을 다룹니다. Expert Parallelism, PD Disaggregation(Prefill/Decode 분리), HiCache(계층형 KV 캐싱), Speculative Decoding까지 프로덕션 수준의 최적화 기법들을 분석합니다.

## 참고 자료

- Zheng, L. et al. (2024). *SGLang: Efficient Execution of Structured Language Model Programs*. NeurIPS 2024. [arXiv:2312.07104](https://arxiv.org/abs/2312.07104)
- LMSYS. (2024). *Fast JSON Decoding for Local LLMs with Compressed Finite State Machine*. [LMSYS Blog](https://lmsys.org/blog/2024-02-05-compressed-fsm/)
- Dong, Y. et al. (2024). *XGrammar: Flexible and Efficient Structured Generation Engine for Large Language Models*. [MLC Blog](https://blog.mlc.ai/2024/11/22/achieving-efficient-flexible-portable-structured-generation-with-xgrammar)
- Dong, Y. et al. (2025). *XGrammar 2: Blazing-Fast Structured Output for Agentic LLM Workloads*. [arXiv:2601.04426](https://arxiv.org/abs/2601.04426)
- SqueezeBits. (2025). *Guided Decoding Performance: vLLM vs SGLang*. [SqueezeBits Blog](https://blog.squeezebits.com/guided-decoding-performance-vllm-sglang)
- Geng, S. et al. (2025). *JSONSchemaBench: A Comprehensive Benchmark for Evaluating JSON Schema Generation*. [arXiv:2501.10868](https://arxiv.org/abs/2501.10868)
- vLLM. (2025). *Structured Decoding in vLLM*. [vLLM Blog](https://vllm.ai/blog/struct-decode-intro)
- SGLang Documentation. *Structured Outputs*. [docs.sglang.ai](https://docs.sglang.io/advanced_features/structured_outputs.html)
- XGrammar GitHub. [github.com/mlc-ai/xgrammar](https://github.com/mlc-ai/xgrammar)
- LLGuidance GitHub. [github.com/guidance-ai/llguidance](https://github.com/guidance-ai/llguidance)
