---
layout: single
title: "FluentBit과 OpenSearch를 활용한 로그 수집 및 최적화: ISM을 통한 라이프사이클 관리"
date: 2025-09-07 15:00:00 +0000
categories: monitoring
tags: [fluentbit, opensearch, logging, ism, kubernetes]
excerpt: "FluentBit과 OpenSearch를 결합한 로깅 아키텍처에서 Index State Management(ISM)를 활용한 효율적인 인덱스 라이프사이클 관리와 법적 요구사항을 고려한 로그 보관 정책을 다룹니다."
---

# FluentBit과 OpenSearch를 활용한 로그 수집 및 최적화: ISM을 통한 라이프사이클 관리

Kubernetes 환경에서 대용량 로그를 효율적으로 관리하기 위해서는 적절한 인덱스 라이프사이클 관리가 필수입니다. 특히 법적 요구사항과 비용 효율성을 동시에 만족시키는 로그 보관 정책을 수립하는 것은 많은 고민이 필요한 영역입니다. 이번 포스트에서는 OpenSearch의 Index State Management(ISM)를 활용한 자동화된 로그 관리와 실무에서 직면하는 보관 정책 수립의 고민들을 공유하겠습니다.

## OpenSearch Index State Management (ISM) 개요

### ISM의 핵심 개념

[OpenSearch의 Index State Management (ISM)](https://docs.aws.amazon.com/ko_kr/opensearch-service/latest/developerguide/ism.html)은 정책 기반 시스템으로 인덱스 라이프사이클을 자동으로 관리합니다. ISM은 다음과 같은 핵심 기능을 제공합니다:

- **자동화된 정책 실행**: 인덱스에 대한 주기적인 작업 자동화
- **사용자 정의 관리 정책**: 비즈니스 요구사항에 맞는 맞춤형 정책 정의
- **저장 단계별 이동**: hot, warm, cold 등 다양한 저장 티어 간 자동 이동

ISM 정책은 5-8분마다 실행되어 정의된 조건을 확인하고 필요한 액션을 수행합니다.

### ISM 정책 구조

ISM 정책은 다음과 같은 구성 요소로 이루어집니다:

- **States**: 인덱스 라이프사이클의 다양한 단계를 정의
- **Transitions**: 상태 간 이동 조건을 설정
- **Actions**: 각 상태에서 수행할 특정 작업을 명시

## 실제 ISM 정책 구현

### Hot-Warm-Cold-Delete 4단계 정책

```json
{
  "policy": {
    "description": "로그 인덱스 라이프사이클 관리 정책",
    "default_state": "hot",
    "states": [
      {
        "name": "hot",                    // 신규 로그가 활발히 인덱싱되는 단계
        "actions": [
          {
            "rollover": {                 // 인덱스 크기나 시간 기준으로 새 인덱스 생성
              "min_size": "30gb",         // 30GB 도달 시 롤오버
              "min_doc_count": 50000000,  // 5천만 문서 도달 시 롤오버
              "min_index_age": "1d"       // 1일 경과 시 롤오버
            }
          }
        ],
        "transitions": [
          {
            "state_name": "warm",         // 다음 단계로의 전환
            "conditions": {
              "min_index_age": "7d"       // 7일 후 warm 단계로 이동
            }
          }
        ]
      },
      {
        "name": "warm",                   // 검색 빈도가 줄어든 로그들의 최적화 단계
        "actions": [
          {
            "replica_count": {            // 복제본 수 유지 (가용성 보장)
              "number_of_replicas": 1
            }
          },
          {
            "force_merge": {              // 세그먼트 병합으로 검색 성능 향상
              "max_num_segments": 1       // 모든 세그먼트를 1개로 병합
            }
          }
        ],
        "transitions": [
          {
            "state_name": "cold",
            "conditions": {
              "min_index_age": "30d"      // 30일 후 cold 단계로 이동
            }
          }
        ]
      },
      {
        "name": "cold",                   // 장기 보관용 최소 리소스 사용 단계
        "actions": [
          {
            "replica_count": {            // 복제본 제거로 스토리지 비용 절약
              "number_of_replicas": 0     // 복제본 없음 (비용 최적화)
            }
          }
        ],
        "transitions": [
          {
            "state_name": "delete",
            "conditions": {
              "min_index_age": "365d"     // 1년 후 삭제 (법적 요구사항에 따라 조정)
            }
          }
        ]
      },
      {
        "name": "delete",                 // 보관 기간 만료된 로그 자동 삭제
        "actions": [
          {
            "delete": {}                  // 인덱스 완전 삭제
          }
        ]
      }
    ],
    "ism_template": {                     // 정책을 적용할 인덱스 패턴
      "index_patterns": ["logs-*"],      // logs-로 시작하는 모든 인덱스에 적용
      "priority": 100                    // 정책 우선순위
    }
  }
}
```

### ISM 정책 적용 방법

```bash
# 1. ISM 정책 생성 - 위에서 정의한 라이프사이클 정책을 OpenSearch에 등록
PUT _plugins/_ism/policies/logs-policy
{
  "policy": {
    # 위의 정책 내용 전체를 여기에 입력
  }
}

# 2. 인덱스 템플릿에 ISM 정책 적용 - 새로 생성되는 인덱스에 자동으로 정책 적용
PUT _index_template/logs-template
{
  "index_patterns": ["logs-*"],         // logs-* 패턴 인덱스에 적용
  "template": {
    "settings": {
      "opendistro.index_state_management.policy_id": "logs-policy",     // 적용할 정책 ID
      "opendistro.index_state_management.rollover_alias": "logs-active" // 롤오버용 별칭
    }
  }
}

# 3. ISM 정책 상태 확인 - 정책이 올바르게 적용되고 실행되는지 모니터링
GET _plugins/_ism/explain/logs-*
```

## 법적 요구사항을 고려한 로그 보관 정책

### 실무에서 마주한 보관 정책 수립의 고민

대규모 시스템을 운영하면서 가장 고민이 되었던 부분은 **법적 요구사항과 비용 효율성을 동시에 만족하는 로그 보관 정책을 어떻게 수립할 것인가**였습니다. 단순히 모든 로그를 무기한 보관하는 것은 스토리지 비용 측면에서 현실적이지 않고, 반대로 너무 짧은 보관 기간은 법적 리스크와 장애 분석 시의 제약을 가져올 수 있기 때문입니다.

### 개인정보보호법에 따른 로그 보관 요구사항

**개인정보 관련 로그**:
- **보관 기간**: 대규모 처리기관(5만 명 이상 개인정보 처리 또는 고유식별정보/민감정보 처리 시스템) 기준 **2년**, 향후 **5년**까지 확대 예정(2025년 1월 개정)
- **필수 기록 항목**:
  - 접속자 계정
  - 접속일시
  - 접속지 정보
  - 처리한 정보주체 정보
  - 수행업무

**일반 시스템 로그**:
- 보관 기간: 내부 기준에 따라 설정 (보통 1년 이상 권장)
- 포함 항목:
  - 시스템 이벤트 로그 (시작, 종료, 상태, 에러)
  - 네트워크 이벤트 로그 (IP주소 할당, 트래픽)
  - 보안시스템 로그 (관리자 접속, 정책 변경)
  - 보안관련 감사 로그 (사용자 접속, 인증, 파일 접근)

### 실무 관점에서의 보관 정책 최적화

법적 요구사항을 충족하면서도 운영 효율성을 고려한 정책을 수립할 때, 다음과 같은 고민 과정을 거쳤습니다:

1. **차등 보관 정책의 필요성**: 모든 로그를 동일한 기간 동안 보관할 필요가 있는가?
2. **접근 빈도에 따른 티어링**: 최근 로그는 빠른 검색이 필요하지만, 오래된 로그는 컴플라이언스 목적으로만 보관하면 되는가?
3. **비용 대비 효과**: 스토리지 비용과 법적 리스크 간의 균형점은 어디인가?

### 법적 요구사항을 반영한 ISM 정책

이러한 고민을 바탕으로 수립한 5년 보관 정책입니다:

```json
{
  "policy": {
    "description": "개인정보보호법 준수 로그 보관 정책 (5년 보관)",
    "default_state": "hot",
    "states": [
      {
        "name": "hot",                    // 최근 1개월: 빠른 검색과 실시간 분석 지원
        "actions": [
          {
            "rollover": {
              "min_size": "30gb",         // 일별 롤오버로 관리 용이성 확보
              "min_index_age": "1d"
            }
          }
        ],
        "transitions": [
          {
            "state_name": "warm",
            "conditions": {
              "min_index_age": "30d"      // 1개월 후 warm으로 이동
            }
          }
        ]
      },
      {
        "name": "warm",                   // 1-3개월: 주기적 분석용, 성능 최적화
        "actions": [
          {
            "replica_count": {
              "number_of_replicas": 1     // 가용성 유지하되 비용 고려
            }
          },
          {
            "force_merge": {
              "max_num_segments": 1       // 검색 성능 최적화
            }
          }
        ],
        "transitions": [
          {
            "state_name": "cold",
            "conditions": {
              "min_index_age": "90d"      // 3개월 후 cold로 이동
            }
          }
        ]
      },
      {
        "name": "cold",                   // 3개월-5년: 컴플라이언스 목적 보관
        "actions": [
          {
            "replica_count": {
              "number_of_replicas": 0     // 복제본 제거로 스토리지 비용 50% 절약
            }
          }
        ],
        "transitions": [
          {
            "state_name": "delete",
            "conditions": {
              "min_index_age": "1825d"    // 5년 (5 × 365일) 후 삭제
            }
          }
        ]
      },
      {
        "name": "delete",
        "actions": [
          {
            "delete": {}                  // 법적 보관 기간 만료 후 자동 삭제
          }
        ]
      }
    ]
  }
}
```

## 용량 산정 및 스토리지 계획

### 실제 업무에서 마주한 용량 계획의 어려움

로그 시스템을 설계하면서 가장 어려웠던 부분 중 하나는 **정확한 용량 예측과 미래 확장성을 고려한 스토리지 계획**이었습니다. 다음과 같은 변수들을 고려해야 했습니다:

- 서비스 성장에 따른 로그 증가율
- 압축률의 현실적인 예측치
- 법적 요구사항 변경에 따른 보관 기간 연장 가능성
- 예산 제약과 스토리지 비용 최적화

### 5년 보관 기준 용량 계산

실제 시스템 운영 경험을 바탕으로 한 현실적인 용량 산정 과정:

```yaml
# 기본 전제 조건
일일_로그_발생량: 80GB                    # 실측 데이터 기반
보관_기간: 5년 (1,825일)                  # 법적 요구사항 반영
최대_스토리지_사용률: 70%                 # 운영 안정성 확보

# 압축을 고려하지 않은 기본 계산
총_로그_볼륨: 80GB × 1,825일 = 146,000GB (142.6TB)
안전_마진_포함_용량: 146,000GB ÷ 0.7 = 208,571GB (203.7TB)

# 현실적인 압축률 적용 (운영 경험 기반)
텍스트_로그_압축률: 85%                   # 일반적인 gzip 압축 기준
최종_예상_용량: 203.7TB × 0.15 = 30.6TB

# 예산 제약을 고려한 단계별 확장 계획
1년차_목표: 6TB                          # 초기 구축 비용 최소화
3년차_목표: 18TB                         # 중기 확장
5년차_최종: 30TB                         # 최종 목표 용량
```

### 비용 최적화를 위한 현실적인 접근

무작정 최대 용량을 확보하는 것보다는, **단계적 확장과 정책 최적화를 통한 비용 효율성**을 추구했습니다:

1. **초기 1년**: 보수적인 6TB로 시작하여 실제 사용 패턴 파악
2. **정책 조정**: 실제 압축률과 로그 증가율을 바탕으로 ISM 정책 최적화
3. **단계적 확장**: 예산 계획에 맞춘 점진적 용량 증설

```yaml
# 현실적인 1년 기준 계획
일_로그_발생량: 80GB
연간_총_볼륨: 29,200GB (28.5TB)
압축_후_예상_용량: 4.3TB                 # 85% 압축률 적용
안전_마진_포함: 6TB                      # 40% 여유 공간 확보

# 이는 다음과 같은 장점을 제공:
# - 초기 투자 비용 절약
# - 실제 사용 패턴 기반 최적화
# - 예산 계획의 유연성 확보
```

## ISM 정책 모니터링 및 관리

### ISM 상태 모니터링

정책이 올바르게 동작하는지 확인하기 위한 모니터링 명령어들:

```bash
# 전체 인덱스의 ISM 상태 확인 - 정책 적용 현황과 각 단계별 상태를 한눈에 파악
GET _plugins/_ism/explain

# 특정 패턴 인덱스의 ISM 상태 확인 - logs-* 패턴 인덱스들의 라이프사이클 단계 확인
GET _plugins/_ism/explain/logs-*

# ISM 정책 목록 조회 - 등록된 모든 정책 확인
GET _plugins/_ism/policies

# 특정 정책 상세 정보 - 정책 설정 내용과 적용 현황 상세 조회
GET _plugins/_ism/policies/logs-policy
```

### ISM 정책 업데이트

운영 중에 정책을 수정하거나 수동으로 관리해야 하는 경우:

```bash
# 기존 정책 수정 - 보관 기간 변경이나 전환 조건 최적화 시 사용
PUT _plugins/_ism/policies/logs-policy
{
  "policy": {
    "description": "업데이트된 로그 정책 - 보관 기간 3년으로 변경",
    # 수정된 정책 내용
  }
}

# 인덱스에 정책 수동 적용 - 기존 인덱스에 새 정책 적용
POST _plugins/_ism/add/logs-2025.01.13
{
  "policy_id": "logs-policy"
}

# 정책 변경 사항 강제 실행 - 긴급히 특정 단계로 이동이 필요한 경우
POST _plugins/_ism/retry/logs-2025.01.13
{
  "state": "warm"                       # 즉시 warm 단계로 전환
}
```

## 결론

OpenSearch의 ISM을 활용한 자동화된 인덱스 라이프사이클 관리는 단순히 기술적인 구현을 넘어서 **비즈니스 요구사항과 법적 컴플라이언스, 그리고 비용 효율성을 균형있게 고려한 정책 설계**가 핵심입니다.

실무에서 얻은 주요 교훈:

1. **법적 준수와 비용 효율성의 균형**: 개인정보 관련 로그는 최소 5년 보관하되, 단계별 티어링으로 비용 최적화
2. **점진적 접근의 중요성**: 완벽한 계획보다는 실측 데이터 기반의 점진적 최적화가 더 효과적
3. **자동화의 가치**: 수동 관리의 한계를 ISM 정책을 통해 극복하고 일관성 있는 라이프사이클 관리 실현
4. **모니터링과 조정**: 정책 수립 후에도 지속적인 모니터링과 조정이 필요

특히 **"완벽한 처음 설계보다는 합리적인 시작과 지속적인 개선"**이 더 중요하다는 것을 경험했습니다. 실제 데이터와 사용 패턴을 바탕으로 정책을 조정해 나가는 것이 이론적 계산보다 훨씬 효과적이었습니다.

다음 포스트에서는 **"OpenSearch 클러스터 보안 설정과 접근 제어"**에 대해 다루겠습니다.

---

**참고 자료**
- [Amazon OpenSearch Service - Index State Management](https://docs.aws.amazon.com/ko_kr/opensearch-service/latest/developerguide/ism.html)
- [OpenSearch Documentation - ISM Plugin](https://docs.opensearch.org/latest/im-plugin/ism/index/)

**관련 포스트**
- [Kubernetes 로깅 아키텍처 설계](/kubernetes/logging/2025/04/09/kubernetes-logging-architecture/)
- [Kubernetes 모니터링 스택 구축하기](/kubernetes/monitoring/2025/04/08/kubernetes-monitoring-tracing-logging-monitoring/)