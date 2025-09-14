---
layout: single
title: "Agent-OS를 만나다 - 개발 생산성의 새로운 패러다임 [Claude Code 오픈소스 기여 도전기 #1]"
date: 2025-09-13 20:30:00 +0900
categories: development
tags: [claude-code, agent-os, grafana, kafka, alloy, opensource]
---

저는 요즘 claude-code로 여러 가지 작업을 하고 있습니다. 블로그 글 작성, 배치 작업, Ai-agent 생성 등등...
이 녀석의 성능에 항상 놀라고 있는데, 오늘 미용실에서 GeekNews(https://news.hada.io/) 글을 읽다가, 흥미로운 글을 읽었습니다.
클로드 코드를 활용하는 프레임워크들이 속속 등장하고 있고, 이를 활용하면 안 그래도 엄청난 이 녀석의 생산력이 극대화된다는 내용이었습니다. 
저는 집에 돌아와 agent-os를 구성했고, 아! 이 녀석이라면 더 다양한 작업을 할 수 있겠구나 싶었습니다.

이제부터는 agent-os, claude-code가 이 글을 작성하게 됩니다.

## "이거 정말 대단한데요?" - Agent-OS 첫 인상

혹시 여러분도 AI 코딩 도구를 사용하다가 이런 경험 있으신가요? "오, 이거 좋네! 그런데... 뭔가 체계적이지가 않아." 

제가 Claude Code를 쓰면서 느꼈던 아쉬움이 바로 그것이었어요. 물론 코드 작성이나 문제 해결 능력은 정말 놀라웠지만, 프로젝트 전체를 관리하고 체계적으로 진행하기에는 뭔가 부족했거든요.

그런데 Agent-OS를 만나고 나서 "아, 이거구나!" 싶었습니다. 이건 단순히 AI에게 "이것 좀 해줘"라고 요청하는 게 아니라, 진짜 팀원과 함께 일하는 느낌이에요. 체계적인 프로젝트 관리부터 표준화된 워크플로우까지, 모든 게 준비되어 있더라고요.

### 설치 과정

설치는 놀랍도록 간단했습니다:

```bash
curl -sSL https://raw.githubusercontent.com/buildermethods/agent-os/main/setup/base.sh | bash -s -- --claude-code
```

설치가 완료되면 `~/.agent-os/` 디렉토리에 다음과 같은 구조가 생성됩니다:

```
.agent-os/
├── config.yml              # 버전 및 프로젝트 타입 설정
├── standards/               # 기술 스택 및 코딩 스타일 가이드
│   ├── tech-stack.md
│   ├── best-practices.md
│   └── code-style/
├── instructions/            # 핵심 Agent OS 지침
│   ├── core/
│   └── meta/
├── commands/                # 실행 가능한 명령어들
│   ├── analyze-product.md
│   ├── create-tasks.md
│   └── execute-tasks.md
└── claude-code/            # Claude Code 전용 에이전트들
    └── agents/
```

## 실제 프로젝트 시작: Grafana Observability Enhancer

Agent-OS의 진가를 확인하기 위해 실제 오픈소스 기여 프로젝트를 시작했습니다. 선택한 프로젝트는 **Grafana Foundation의 Alloy-Kafka 통합 개선**입니다.

### 프로젝트 미션 정의

Agent-OS는 모든 프로젝트가 명확한 미션을 가져야 한다고 강조합니다. 우리 프로젝트의 미션은 다음과 같습니다:

> **Grafana Observability Enhancer**는 DevOps 엔지니어와 SRE 팀이 Grafana Foundation 도구들(Alloy, Tempo, Loki)을 개선하여 실제 관측 가능성 문제를 해결하는 오픈소스 기여 이니셔티브입니다.

### 왜 이 프로젝트를 선택했는가?

1. **실제 문제 해결**: Alloy-Kafka 통합에서 연결 안정성 이슈가 실제로 존재
2. **생산성 있는 기여**: 60%의 DevOps 팀이 설정 어려움을 호소하는 영역
3. **학습 기회**: Kubernetes, Kafka, Go 등 다양한 기술 스택 경험
4. **커뮤니티 가치**: Grafana Foundation의 활발한 오픈소스 생태계

## Phase 1: 환경 구축의 여정

### k3d 클러스터 준비

첫 번째 단계는 개발 환경 구축이었습니다. k3d를 사용해 로컬 Kubernetes 클러스터를 생성했습니다:

```bash
k3d cluster create alloy-kafka-dev
```

### Kafka 배포: 예상치 못한 도전

Kafka 배포에서 첫 번째 큰 장벽을 만났습니다. Strimzi Operator를 사용하려 했지만, 0.47.0 버전부터 KRaft 모드만 지원한다는 문제가 발생했습니다:

```
InvalidConfigurationException: Strimzi 0.47.0 supports only KRaft-based Apache Kafka clusters
```

여러 시행착오 끝에 Bitnami Kafka 차트로 전환하여 성공했습니다:

```bash
helm install kafka bitnami/kafka --namespace kafka \
  --set controller.replicaCount=1 \
  --set sasl.enabled=false \
  --set auth.sasl.enabled=false
```

### Grafana Alloy 소스 빌드

Alloy 소스를 클론하고 빌드하는 과정도 흥미로웠습니다:

```bash
cd ~/alloy-kafka-dev/alloy
git clone https://github.com/grafana/alloy.git .
go build -o build/alloy .
```

빌드 결과:
- 바이너리 크기: 531MB
- 버전: v1.11.0-devel
- Go 버전: 1.25.1

## Agent-OS의 실제 효과

### 체계적인 프로젝트 관리

Agent-OS의 가장 큰 장점은 체계적인 프로젝트 관리입니다. TodoWrite 도구를 통해 모든 작업을 추적하고, 단계별로 진행상황을 관리할 수 있었습니다:

```markdown
✅ kubectx/kubens 설치 완료
✅ 프로젝트 폴더 생성 완료  
✅ Kafka 배포 완료
✅ Alloy 소스 빌드 완료
🔄 통합 테스팅 환경 구축 진행 중
```

### 문제 해결 패턴의 진화

AI가 문제를 해결하는 과정을 지켜보는 것이 매우 흥미로웠습니다:

1. **첫 시도**: 공식 문서 기반 접근 (Strimzi)
2. **문제 인식**: 로그 분석으로 근본 원인 파악
3. **대안 탐색**: KRaft 설정, KafkaNodePool 등 시도  
4. **실용적 해결**: Bitnami 차트로 목적 달성

### 실시간 문서화

모든 과정이 자동으로 기록되고 있다는 점이 놀라웠습니다. 개발 로그, 기술적 의사결정, 심지어 실패한 시도들까지 모두 체계적으로 문서화되었습니다.

## 다음 편에서는...

2편에서는 실제 Alloy-Kafka 통합 설정과 이슈 재현 과정을 다룰 예정입니다. 어떤 문제들이 발견될지, 그리고 Claude Code와 Agent-OS가 어떻게 해결해 나갈지 기대해 주세요!

## 프로젝트 현재 상태

```
alloy-kafka-dev/
├── kafka/          # Kafka 배포 설정 ✅
├── alloy/          # Alloy 소스 코드 ✅  
├── observability/  # 모니터링 스택 (예정)
├── tests/          # 통합 테스트 (예정)
└── docs/           # 문서 ✅
```

**다음 단계**: Kafka 토픽 생성, Alloy-Kafka 통합, 실제 이슈 재현

---

*이 시리즈는 Claude Code와 Agent-OS를 활용한 실제 오픈소스 기여 과정을 실시간으로 기록합니다. 모든 코드와 과정은 GitHub에서 확인하실 수 있습니다.*