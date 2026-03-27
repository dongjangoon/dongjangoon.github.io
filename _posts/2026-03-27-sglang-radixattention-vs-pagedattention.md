---
layout: single
title: "RadixAttention vs PagedAttention - KV Cache 전략의 근본적 차이 (SGLang 시리즈 Part 2)"
date: 2026-03-27 10:00:00 +0900
categories: mlops
tags: [sglang, vllm, radix-attention, paged-attention, kv-cache, prefix-caching, llm-serving, inference]
excerpt: "SGLang의 RadixAttention과 vLLM의 PagedAttention은 같은 문제(KV cache 관리)를 근본적으로 다른 자료구조로 해결합니다. Radix Tree vs Hash Table, 가변 노드 vs 고정 블록, Tree 순회 vs 해시 룩업. 이 글에서는 소스 코드 수준에서 두 접근법의 구조적 차이를 분석하고, Cache-Aware Scheduling과 Eviction 전략까지 깊이 파고듭니다."
---

> 이 글은 **SGLang v0.5.9** (2026년 2월)과 **vLLM v0.17.1** (2026년 3월) 기준으로 작성되었습니다.

## 들어가며

[Part 1]({{ site.baseurl }}{% post_url 2026-03-26-sglang-architecture-deep-dive %})에서 SGLang의 전체 아키텍처를 살펴봤습니다. 그 중 RadixAttention은 "요청 간 KV cache를 자동으로 재활용한다"는 설명만 간략히 다뤘습니다.

이 글에서는 RadixAttention의 내부를 깊이 파고들겠습니다. 비교 대상은 vLLM의 PagedAttention과 그 위에 구현된 APC(Automatic Prefix Caching)입니다.

두 시스템은 같은 문제를 해결합니다. **"LLM 서빙에서 KV cache를 어떻게 효율적으로 관리할 것인가?"** 하지만 선택한 자료구조와 설계 철학이 근본적으로 다르며, 이 차이가 스케줄링, 캐시 재활용, 메모리 관리 전반에 파급됩니다.

## 배경: KV Cache는 왜 관리가 어려운가

[이전 포스트]({{ site.baseurl }}{% post_url 2025-11-04-kv-caching-gpu-parallelism %})에서 KV cache의 기본 구조와 메모리 계산을 다뤘습니다. 핵심만 짚으면 다음과 같습니다.

- LLM의 각 Transformer 레이어는 Attention 계산 시 이전 토큰들의 **Key, Value 텐서**를 참조합니다.
- 이 텐서들을 매번 다시 계산하면 낭비이므로 GPU 메모리에 캐싱합니다. 이것이 **KV cache**입니다.
- Llama-70B 기준, 시퀀스 하나의 KV cache는 수 GB에 달합니다.

문제는 KV cache가 **동적으로 증가**한다는 것입니다. Decode 단계에서 토큰이 하나 생성될 때마다 KV cache가 한 행씩 늘어납니다. 요청마다 최종 길이가 다르고, 언제 끝날지 예측할 수 없습니다.

```
요청 시작 시: KV cache = [prompt 길이] 행
토큰 1 생성: KV cache += 1행
토큰 2 생성: KV cache += 1행
...
요청 완료 시: KV cache = [prompt + 생성된 토큰 수] 행 → 전체 해제

→ 최대 길이를 미리 할당하면 메모리 낭비 (60~80%)
→ 동적 할당하면 fragmentation 발생
```

PagedAttention과 RadixAttention은 이 문제에 대한 서로 다른 해답입니다.

## PagedAttention: 고정 블록 + 해시 테이블

### 핵심 아이디어

PagedAttention은 OS의 가상 메모리 시스템에서 직접 영감을 받았습니다. 연속적인 KV cache를 고정 크기 **블록(페이지)** 으로 분할하여 비연속적인 물리 메모리에 저장합니다.

```
KV Cache (논리적으로 연속):
┌───────────────────────────────────────────────────┐
│ tok0 tok1 tok2 ... tok15 │ tok16 tok17 ... tok31 │ tok32 ...
└───────────────────────────────────────────────────┘

PagedAttention (물리적으로 비연속):
Block 0 (GPU 주소 0x1000): [tok0  ~ tok15]   ← 16토큰/블록
Block 1 (GPU 주소 0x5000): [tok16 ~ tok31]
Block 2 (GPU 주소 0x2000): [tok32 ~ ...]
                            ↑ 물리 주소가 연속일 필요 없음

Block Table (논리 → 물리 매핑):
  논리 블록 0 → 물리 블록 @ 0x1000
  논리 블록 1 → 물리 블록 @ 0x5000
  논리 블록 2 → 물리 블록 @ 0x2000
```

이 구조에서 fragmentation은 각 시퀀스의 마지막 블록에서만 발생합니다. 블록 크기가 16토큰일 때, 평균 약 8토큰(0.5블록)의 낭비만 존재합니다.

### APC (Automatic Prefix Caching)

PagedAttention 자체는 요청 간 KV cache 공유를 지원하지 않습니다. vLLM은 이를 해결하기 위해 **APC(Automatic Prefix Caching)** 를 추가했습니다.

APC의 핵심은 **블록 해싱**입니다. 각 블록을 고유하게 식별할 수 있는 해시를 계산하여, 동일한 토큰 시퀀스를 가진 블록을 재활용합니다.

```python
# vLLM APC의 블록 해시 계산 (개념적 구현)
def compute_block_hash(parent_block_hash, token_ids_in_block, extra_keys):
    # SHA256 해시 (v0.8.3+, 멀티테넌트 환경에서 충돌 방지)
    return sha256(
        parent_block_hash,        # 이전 블록의 해시 (체이닝)
        token_ids_in_block,       # 현재 블록의 토큰 ID들 (16개)
        extra_keys                # LoRA ID, 멀티모달 해시 등
    )
```

```
요청 A: "당신은 금융 전문가입니다. 삼성전자 분석해주세요."
         ├─ Block 0: hash_A0 = sha256(None, [tok0..tok15], ...)
         ├─ Block 1: hash_A1 = sha256(hash_A0, [tok16..tok31], ...)
         └─ Block 2: hash_A2 = sha256(hash_A1, [tok32..tok40], ...)

요청 B: "당신은 금융 전문가입니다. LG전자 분석해주세요."
         ├─ Block 0: hash_B0 = sha256(None, [tok0..tok15], ...)  ← hash_A0과 동일!
         ├─ Block 1: hash_B1 = sha256(hash_B0, [tok16..tok28], ...)  ← 다름 (분기점)
         └─ Block 2: ...

→ Block 0은 동일한 해시 → 물리 블록 공유 (KV cache 재계산 불필요)
→ Block 1에서 "삼성전자" vs "LG전자"로 분기 → 별도 블록 할당
```

### APC의 구조적 특성

| 속성 | 값 |
|------|-----|
| **자료구조** | Hash table (`BlockHashToBlockMap`) |
| **블록 크기** | 고정 (기본 16토큰) |
| **해시 함수** | SHA256 (v0.8.3+) 또는 Python builtin hash |
| **룩업 복잡도** | O(1) per block, O(n/block_size) per sequence |
| **참조 관리** | `ref_cnt` per block |
| **Eviction** | LRU, 가장 긴 prefix chain의 끝 블록 우선 |
| **활성화** | `--enable-prefix-caching` 플래그 필요 (v0.17 기준) |

## RadixAttention: 가변 노드 + Radix Tree

### Radix Tree란

Radix tree(Patricia trie)는 **공통 prefix를 공유하는 문자열들을 효율적으로 저장하는 트리 자료구조**입니다. 일반 trie와 달리, 공통 prefix를 하나의 edge로 압축하여 공간 효율을 높입니다.

```
일반 Trie:                      Radix Tree (압축):
     [root]                         [root]
      / \                           / \
     당  Y                    [당신은]  [You are]
     |   |                      / \        |
     신  o                 [금융]  [투자]  [a helpful]
     |   |                  |      |
     은  u                [전문가] [분석가]
     ...
```

SGLang은 이 radix tree의 각 노드에 **KV cache의 GPU 메모리 인덱스**를 저장합니다. edge의 label은 **토큰 ID 시퀀스**입니다.

### TreeNode 구조 (소스 코드 기반)

SGLang의 `radix_cache.py`에 정의된 `TreeNode`의 핵심 필드를 살펴보겠습니다.

```python
class TreeNode:
    def __init__(self):
        # 트리 구조
        self.children = defaultdict(TreeNode)  # child_key → TreeNode
        self.parent: TreeNode = None
        self.key: RadixKey = None              # 이 edge의 토큰 시퀀스

        # KV Cache 저장
        self.value: torch.Tensor = None        # GPU 메모리 인덱스 (int64)
        self.host_value: torch.Tensor = None   # CPU 백업 (HiCache용)

        # Eviction 제어
        self.lock_ref = 0                      # 참조 카운트
        self.last_access_time = time.monotonic()
        self.hit_count = 0                     # LFU용

        # 메타데이터
        self.creation_time = time.monotonic()
        self.priority = 0                      # 우선순위 기반 eviction용
```

`RadixKey`는 토큰 시퀀스와 부가 정보를 함께 저장합니다.

```python
class RadixKey:
    token_ids: List[int]       # 토큰 ID 시퀀스 (가변 길이)
    extra_key: Optional[str]   # 네임스페이스 (LoRA ID, cache_salt 등)
```

### KV Cache가 Tree에 저장되는 방식

`value` 필드에는 실제 KV 텐서가 아니라 **메모리 풀의 인덱스**가 저장됩니다. 이 인덱스를 통해 `TokenToKVPoolAllocator`에서 관리하는 실제 GPU 메모리에 접근합니다.

```
RadixCache Tree:
         [root]
           │
    ┌──────┴──────┐
    │             │
  Node A         Node B
  key: [101, 234, 567, ...]    key: [201, 345, ...]
  value: tensor([0, 1, 2, ...])  value: tensor([50, 51, ...])
    │                              ↓
    │                        GPU Memory Pool
    │                        ┌─────────────┐
    └──────────────────────→ │ idx 0: K,V  │
                             │ idx 1: K,V  │
                             │ idx 2: K,V  │
                             │ ...         │
                             │ idx 50: K,V │
                             │ idx 51: K,V │
                             └─────────────┘
```

이 간접 참조(indirection) 덕분에 tree 구조의 변경(노드 분할, 삭제)이 실제 GPU 메모리를 복사하지 않고 인덱스만 조작하여 수행됩니다.

### Prefix Matching 알고리즘

새 요청이 들어왔을 때 RadixCache에서 prefix를 찾는 과정을 단계별로 추적해 보겠습니다.

```python
# _match_prefix_helper (radix_cache.py, 개념적 재구성)
def match_prefix(self, key: List[int]) -> Tuple[torch.Tensor, TreeNode]:
    node = self.root_node
    matched_indices = []

    while len(key) > 0:
        child_key = key[0]  # 첫 번째 토큰으로 자식 탐색

        if child_key not in node.children:
            break  # 매칭 종료

        child = node.children[child_key]
        child.last_access_time = time.monotonic()  # 접근 시간 갱신

        # edge의 토큰 시퀀스와 입력 key를 비교
        prefix_len = common_prefix_length(child.key, key)

        if prefix_len < len(child.key):
            # 부분 매칭: 노드를 분할해야 함
            self._split_node(child, prefix_len)
            matched_indices.append(child.value[:prefix_len])
            break
        else:
            # 완전 매칭: 다음 레벨로 이동
            matched_indices.append(child.value)
            key = key[prefix_len:]  # 매칭된 부분 제거
            node = child

    return torch.cat(matched_indices), node
```

구체적인 예시로 살펴보겠습니다.

```
기존 Tree 상태:
    [root]
      │
    Node A
    key: [101, 234, 567, 890, 123]     ← "당신은 금융 전문가입니다"
    value: tensor([0, 1, 2, 3, 4])
      │
    Node B
    key: [456, 789]                     ← "삼성전자를"
    value: tensor([5, 6])

새 요청: [101, 234, 567, 890, 123, 999, 888]
         "당신은 금융 전문가입니다 LG전자를"

Step 1: root에서 child_key=101 탐색 → Node A 발견
Step 2: Node A의 key [101,234,567,890,123]와 비교
        → 5토큰 전체 매칭 (prefix_len = 5 == len(Node A.key))
        → matched_indices에 tensor([0,1,2,3,4]) 추가
        → 남은 key: [999, 888]

Step 3: Node A에서 child_key=999 탐색 → 없음
        → 매칭 종료

결과: 5토큰 캐시 히트, 2토큰만 새로 prefill하면 됨
      새로 계산된 KV cache는 Node A의 자식으로 삽입:

    [root]
      │
    Node A: [101, 234, 567, 890, 123]
      ├── Node B: [456, 789]         ← 기존 "삼성전자를"
      └── Node C: [999, 888]         ← 새로 추가된 "LG전자를"
```

### 노드 분할 (Node Splitting)

prefix가 기존 노드의 **중간**에서 끝나는 경우, 노드를 분할해야 합니다.

```
기존 상태:
    [root]
      │
    Node A: key=[101, 234, 567, 890]  value=[0, 1, 2, 3]

새 요청: [101, 234, 777, ...]
         → 2토큰만 매칭 (101, 234), 3번째 토큰(567 vs 777)에서 분기

분할 후:
    [root]
      │
    Node A': key=[101, 234]  value=[0, 1]        ← 새로 생성 (공통 prefix)
      ├── Node A: key=[567, 890]  value=[2, 3]   ← 기존 노드 (suffix)
      └── Node C: key=[777, ...]  value=[새 할당]  ← 새 요청의 나머지
```

이 분할은 GPU 메모리의 KV 텐서를 복사하지 않습니다. `value` 텐서의 인덱스만 슬라이싱(`clone`)하여 새 노드에 할당합니다. 실제 KV 데이터는 메모리 풀에 그대로 남아 있습니다.

## 자료구조 비교: Radix Tree vs Hash Table

### 근본적 차이

두 접근법의 차이를 자료구조 관점에서 정리하면 다음과 같습니다.

```
PagedAttention + APC (Hash Table):

  hash("tok0..tok15", None) ─────→ Physical Block 0
  hash("tok16..tok31", hash0) ───→ Physical Block 1
  hash("tok32..tok47", hash1) ───→ Physical Block 2

  → 각 블록은 독립적으로 해시됨
  → 블록 경계가 고정 (16토큰 단위)
  → 룩업: O(1) per block


RadixAttention (Radix Tree):

         [root]
        /      \
   [당신은 금융   [You are a
    전문가입니다]   helpful assistant]
      /    \
  [삼성전자를  [LG전자를
   분석해...]   분석해...]

  → 공통 prefix가 트리 구조로 자연스럽게 공유
  → 노드 크기가 가변적 (1토큰 ~ 수천 토큰)
  → 룩업: O(prefix_length) tree traversal
```

### 상세 비교표

| 속성 | PagedAttention + APC | RadixAttention |
|------|---------------------|----------------|
| **자료구조** | Hash table (flat) | Radix tree (hierarchical) |
| **단위** | 고정 블록 (16토큰) | 가변 노드 (1~N 토큰) |
| **prefix 식별** | 블록별 해시 체이닝 | 트리 경로 탐색 |
| **룩업 복잡도** | O(1) per block | O(prefix_length) traversal |
| **시퀀스 전체 매칭** | O(seq_len / block_size) | O(depth of tree) |
| **분기점 처리** | 블록 경계에서만 공유 가능 | 임의 위치에서 분할 가능 |
| **내부 fragmentation** | 마지막 블록에서 평균 8토큰 낭비 | page_size=1이면 없음 |
| **공유 발견** | 해시 일치로 암묵적 | 트리 구조로 명시적 |
| **Prefix 관계 파악** | 불가 (flat 구조) | 가능 (부모-자식 관계) |
| **활성화** | 별도 플래그 필요 | 기본 내장 |

### 분기점 처리의 차이

가장 중요한 차이는 **prefix가 블록 경계가 아닌 위치에서 분기할 때**입니다.

```
두 요청이 25번째 토큰에서 분기하는 경우:

PagedAttention (블록 크기 = 16):
  Block 0 (tok 0~15):  공유 가능 ✓
  Block 1 (tok 16~31): tok 16~24는 동일하지만 블록 전체를 공유할 수 없음 ✗
                        → Block 1을 각 요청에 대해 별도로 계산

RadixAttention:
  Node A (tok 0~24):   25토큰 전체 공유 ✓  (분기점에서 노드 분할)
  Node B (tok 25~...):  요청 1의 나머지
  Node C (tok 25~...):  요청 2의 나머지
                        → 정확히 분기점까지만 재활용
```

PagedAttention은 공유 가능한 9토큰(tok 16~24)의 KV cache를 재활용하지 못합니다. RadixAttention은 노드 분할로 정확히 분기점까지 재활용합니다. 이 차이는 system prompt의 길이가 블록 크기의 정수배가 아닌 경우에 누적됩니다.

## Cache-Aware Scheduling

RadixAttention의 진정한 강점은 단순한 KV cache 저장을 넘어, **스케줄러가 캐시 상태를 인지하고 요청 순서를 최적화**하는 것입니다.

### 기존 스케줄링의 문제

FCFS(First Come First Served) 스케줄링에서는 요청 순서가 캐시 효율과 무관합니다.

```
Waiting Queue (FCFS):
  1. "시스템 프롬프트 A" + 쿼리 1
  2. "시스템 프롬프트 B" + 쿼리 2
  3. "시스템 프롬프트 A" + 쿼리 3   ← A의 캐시가 아직 살아있으면 좋겠지만...
  4. "시스템 프롬프트 C" + 쿼리 4
  5. "시스템 프롬프트 A" + 쿼리 5

→ A의 KV cache가 B, C 처리 중에 eviction될 수 있음
→ 요청 3, 5에서 A를 다시 계산해야 할 수 있음
```

### DFS_WEIGHT 정책

SGLang의 핵심 스케줄링 정책은 **DFS_WEIGHT**입니다. Radix tree를 DFS(깊이 우선 탐색)으로 순회하면서, 같은 subtree에 속한 요청들을 연속으로 처리합니다.

```python
# schedule_policy.py의 DFS_WEIGHT 구현 (개념적 재구성)
def sort_by_dfs_weight(waiting_queue, tree_cache):
    # 1단계: 각 요청이 매칭된 마지막 노드별로 그룹핑
    last_node_to_reqs = defaultdict(list)
    for req in waiting_queue:
        last_node_to_reqs[req.last_node].append(req)

    # 2단계: 각 노드의 weight 계산 (subtree 내 요청 수)
    node_to_weight = {}
    for node, reqs in last_node_to_reqs.items():
        node_to_weight[node] = len(reqs)
    propagate_weights_to_root(tree_cache.root_node, node_to_weight)

    # 3단계: DFS 순회 (weight가 큰 subtree 먼저)
    sorted_queue = []
    dfs_traverse(tree_cache.root_node, node_to_weight,
                 last_node_to_reqs, sorted_queue)
    return sorted_queue
```

이 알고리즘이 어떻게 동작하는지 예시로 살펴보겠습니다.

```
Radix Tree + Waiting Queue:
         [root]
        /      \
   Node A       Node B
   (weight=3)   (weight=1)
   /    \
 Node C  Node D
 (w=2)   (w=1)

대기 중인 요청:
  req1 → Node C 매칭 (시스템 프롬프트 A + 쿼리 타입 1)
  req2 → Node C 매칭 (시스템 프롬프트 A + 쿼리 타입 1)
  req3 → Node D 매칭 (시스템 프롬프트 A + 쿼리 타입 2)
  req4 → Node B 매칭 (시스템 프롬프트 B)

DFS_WEIGHT 정렬 결과:
  1. req1 (Node C) ← weight 큰 subtree 먼저
  2. req2 (Node C) ← 같은 노드의 요청 연속 처리
  3. req3 (Node D) ← 같은 부모(A)의 다른 자식
  4. req4 (Node B) ← 다른 subtree는 나중에

→ req1, req2가 연속 처리되므로 Node C의 KV cache가 GPU에 확실히 남아있음
→ req3 처리 시 Node A까지의 캐시는 여전히 유효
→ Node B의 캐시는 마지막에 필요하므로, A 계열 처리 중 eviction되어도 무방
```

이 전략은 **radix tree의 구조적 정보를 활용**하기 때문에 가능합니다. PagedAttention의 flat한 hash table에서는 요청 간의 prefix 관계를 파악할 수 없어, 이런 최적화가 구조적으로 어렵습니다.

### In-Batch Prefix Caching

SGLang은 한 단계 더 나아가, **아직 캐시에 없지만 현재 대기열 내에서 prefix를 공유하는 요청들**도 최적화합니다.

```
Waiting Queue:
  req1: "새로운 시스템 프롬프트 X" + 쿼리 1  ← 캐시에 없음
  req2: "새로운 시스템 프롬프트 X" + 쿼리 2  ← 캐시에 없음
  req3: "새로운 시스템 프롬프트 X" + 쿼리 3  ← 캐시에 없음

기존 방식: 세 요청 모두 캐시 미스 → 각각 독립적으로 prefill
SGLang:    req1만 먼저 prefill → 캐시에 X 삽입
           → req2, req3은 X를 캐시에서 재활용
```

스케줄러는 `waiting_queue_radix_tree`라는 시뮬레이션 트리를 유지하며, 대기열 내 요청들의 prefix 공유 관계를 파악합니다. 같은 prefix를 공유하는 요청 중 하나만 먼저 처리하고, 나머지는 `temporary_deprioritized` 집합에 넣어 다음 배치로 미룹니다. 이를 통해 동일한 prefix의 중복 prefill을 방지합니다.

## Eviction 전략

GPU 메모리는 유한하므로, 캐시가 가득 차면 일부를 제거해야 합니다.

### vLLM의 Eviction

vLLM APC는 블록 단위 LRU eviction을 사용합니다. `ref_cnt == 0`인 블록 중 가장 오래 전에 접근된 블록을 제거합니다.

### SGLang의 Eviction

SGLang은 **leaf 노드만 eviction 대상**이라는 제약이 있습니다. 트리 구조를 유지하기 위해 중간 노드를 임의로 삭제할 수 없기 때문입니다.

```python
# radix_cache.py evict() 메서드 (개념적 재구성)
def evict(self, num_tokens_to_free):
    # evictable_leaves: lock_ref == 0인 leaf 노드들
    heap = [(strategy.get_priority(node), node) for node in self.evictable_leaves]
    heapq.heapify(heap)

    freed = 0
    while freed < num_tokens_to_free and heap:
        _, node = heapq.heappop(heap)
        self.free_gpu_memory(node.value)        # GPU 메모리 해제
        freed += len(node.value)
        self.delete_leaf(node)                   # 트리에서 제거

        # 부모가 leaf가 되면 eviction 후보에 추가 (cascade)
        if len(node.parent.children) == 0 and node.parent.lock_ref == 0:
            heapq.heappush(heap, (strategy.get_priority(node.parent), node.parent))
```

SGLang은 7가지 eviction 전략을 제공합니다.

| 전략 | 우선순위 기준 | 적합한 시나리오 |
|------|-------------|----------------|
| **LRU** (기본) | `last_access_time` | 범용적 사용 |
| **LFU** | `(hit_count, last_access_time)` | 특정 prefix가 반복적으로 사용되는 서비스 |
| **FIFO** | `creation_time` | 시간순 처리 |
| **SLRU** | 2-segment (probationary/protected) | hot/cold 분리가 명확한 워크로드 |
| **Priority** | `(priority, last_access_time)` | 중요도가 다른 prefix 혼재 |
| **MRU** | `-last_access_time` | 특수 벤치마크 |
| **FILO** | `-creation_time` | 특수 벤치마크 |

### lock_ref 메커니즘

현재 사용 중인 요청의 KV cache가 eviction되면 안 됩니다. SGLang은 `lock_ref` 카운터로 이를 보장합니다.

```
요청이 처리되기 시작하면:
  matched_node에서 root까지의 경로에 있는 모든 노드의 lock_ref += 1
  → 이 경로의 어떤 노드도 eviction 불가

요청이 완료되면:
  동일 경로의 모든 노드의 lock_ref -= 1
  → lock_ref가 0이 되면 다시 eviction 후보
```

이 메커니즘은 트리 구조 특유의 것입니다. 중간 노드를 보호하면 그 아래의 모든 자식 노드도 간접적으로 보호됩니다.

## 벤치마크: 어디서 차이가 나는가

### SGLang 논문 벤치마크 (A10G GPU)

| 워크로드 | 처리량 향상 | 핵심 요인 |
|---------|-----------|----------|
| MMLU (5-shot) | **4.4x** | 5개 예시의 KV cache 완전 재활용 |
| HellaSwag | **2x** | few-shot 예시 + 문제 prefix 2단계 공유 |
| GSM-8K | **4.5x** | 수학 문제 예시 공유 |
| ReAct Agent | **5.6x** (vs vLLM) | multi-turn에서 이전 턴 KV cache 누적 재활용 |
| JSON 요약 | **2.9x** | 구조화 출력 + prefix 공유 |

RadixAttention의 트리 관리 오버헤드는 캐시 히트가 없는 경우에도 **0.5%** 에 불과합니다 (0.07초 vs Forward Pass 17.6초).

### H100 실환경 벤치마크 (DeepSeek-R1-Distill-Llama-70B)

| 시나리오 | SGLang | vLLM | 차이 |
|---------|--------|------|------|
| 7K context, 캐시 미사용 | 29.5 tok/s | 28.6 tok/s | +3% |
| 7K context, 캐시 활용 | **35.0 tok/s** | 32.8 tok/s | **+7%** |
| 캐시로 인한 개선폭 | **+19%** | +15% | - |
| Multi-turn 캐시 이점 | **10~20% 추가** | - | - |

캐시 미사용 시 두 엔진의 성능 차이는 미미합니다. **차이는 캐시 재활용 시나리오에서 벌어집니다.**

### Cache-Aware Load Balancer 효과 (SGLang v0.4)

SGLang v0.4에서 도입된 Cache-Aware Load Balancer는 여러 서빙 인스턴스 간 요청 라우팅을 최적화합니다.

| 지표 | 개선폭 |
|------|--------|
| 처리량 | **1.9x** |
| 캐시 히트율 | **3.8x** |
| 최적 히트율 대비 달성도 | **~96%** |

## 시나리오별 선택 가이드

### RadixAttention (SGLang)이 유리한 경우

- **Multi-turn 대화 서비스**. 이전 턴의 KV cache를 tree 구조로 자연스럽게 누적 재활용합니다.
- **Few-shot Learning 파이프라인**. 동일한 예시 세트를 공유하는 수백 건의 요청에서 4x 이상의 처리량 향상이 가능합니다.
- **RAG 서비스**. 공통 system prompt + 검색 문서 prefix를 자동으로 캐싱합니다.
- **Agent / Tool Use**. ReAct 패턴에서 이전 사고 과정의 KV cache를 재활용하여 5x 이상 빨라집니다.
- **Cache-aware 스케줄링이 필요한 경우**. 요청 순서 최적화까지 자동으로 수행됩니다.

### PagedAttention + APC (vLLM)이 유리한 경우

- **단일 요청 위주 서빙**. prefix 공유가 거의 없는 독립적인 요청들의 경우, hash 기반 O(1) 룩업이 tree traversal보다 단순합니다.
- **극대규모 캐시**. 수십만 개의 블록을 관리할 때 flat hash table의 오버헤드가 더 예측 가능합니다.
- **Multi-LoRA 서빙**. 해시에 LoRA ID를 포함하여 어댑터별 캐시를 자연스럽게 분리할 수 있습니다.
- **기존 vLLM 파이프라인과의 통합**. 이미 vLLM 기반 인프라가 구축된 경우입니다.

## 마무리

이 글에서 살펴본 핵심 차이를 정리하면 다음과 같습니다.

**PagedAttention + APC**는 OS의 페이징 시스템처럼 **"블록 단위의 효율적 메모리 관리"** 에 집중합니다. Hash table의 O(1) 룩업으로 빠르게 캐시를 찾지만, 블록 경계에서의 공유 제약과 flat 구조로 인해 요청 간 관계를 활용하기 어렵습니다.

**RadixAttention**은 **"요청 간 prefix 관계의 구조적 표현과 활용"** 에 집중합니다. Tree 구조가 prefix 공유 관계를 명시적으로 드러내어, 스케줄링(DFS_WEIGHT), 라우팅(Cache-Aware Load Balancer), eviction까지 캐시 상태를 인지한 전역 최적화를 가능하게 합니다.

다음 **Part 3**에서는 SGLang의 또 다른 핵심 혁신인 **Compressed Finite State Machine**을 다루겠습니다. LLM에서 JSON 스키마 같은 구조화된 출력을 어떻게 효율적으로 보장하는지, 그리고 이것이 RadixAttention과 어떻게 결합되는지 분석합니다.

## 참고 자료

- Zheng, L. et al. (2024). *SGLang: Efficient Execution of Structured Language Model Programs*. NeurIPS 2024. [arXiv:2312.07104](https://arxiv.org/abs/2312.07104)
- Kwon, W. et al. (2023). *Efficient Memory Management for Large Language Model Serving with PagedAttention*. SOSP 2023. [arXiv:2309.06180](https://arxiv.org/abs/2309.06180)
- Ye, Z. et al. (2025). *FlashInfer: Efficient and Customizable Attention Engine for LLM Inference Serving*. MLSys 2025. [arXiv:2501.01005](https://arxiv.org/abs/2501.01005)
- LMSYS. (2024). *Fast and Expressive LLM Inference with RadixAttention and SGLang*. [LMSYS Blog](https://lmsys.org/blog/2024-01-17-sglang/)
- LMSYS. (2024). *SGLang v0.4: Cache-Aware Load Balancer*. [LMSYS Blog](https://lmsys.org/blog/2024-12-04-sglang-v0-4/)
- vLLM Documentation. *Automatic Prefix Caching Design*. [docs.vllm.ai](https://docs.vllm.ai/en/stable/design/prefix_caching/)
- RunPod. (2025). *SGLang vs vLLM: Multi-Turn Conversations and KV Cache Reuse*. [RunPod Blog](https://www.runpod.io/blog/sglang-vs-vllm-kv-cache)
- SGLang GitHub Repository. [github.com/sgl-project/sglang](https://github.com/sgl-project/sglang)
