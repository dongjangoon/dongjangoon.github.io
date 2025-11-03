---
layout: single
title: "WSL k3d 환경에서 ArgoCD 설치와 GitOps 구성하기"
date: 2025-11-03 22:30:00 +0900
categories: infrastructure
tags: [argocd, gitops, kubernetes, k3d, wsl, kustomize]
excerpt: "WSL k3d 클러스터에 ArgoCD를 설치하고 Kustomize 기반 GitOps를 구성하면서 마주친 문제들과 해결 과정을 공유합니다."
---

## 들어가며

실무에서 ArgoCD를 사용하고 있지만, 직접 설치해 본 경험은 이번이 두 번째입니다. 로컬 개발 환경에서 테스트용 클러스터에 ArgoCD를 구축하면서
WSL 환경의 특수성과 k3d의 제약사항, 그리고 ArgoCD의 내부 동작 원리를 깊이 이해하게 되었습니다.

이 글에서는 단순한 설치 가이드를 넘어, **ArgoCD의 철학과 각 컴포넌트의 역할**, 그리고 **실제 설치 과정에서 마주친 문제들의 원인과 해결
방법**을 상세히 다룹니다.

## ArgoCD란?

ArgoCD는 Kubernetes를 위한 선언적 GitOps CD(Continuous Delivery) 도구입니다. CNCF graduated 프로젝트로, Kubernetes 생태계에서 가장 널리
사용되는 GitOps 솔루션 중 하나입니다.

**GitOps의 핵심 철학**

```
Git Repository (Single Source of Truth)
    ↓
ArgoCD가 지속적으로 감시
    ↓
Git 상태 ≠ 클러스터 상태 감지
    ↓
자동으로 동기화 (Auto-Sync)
    ↓
클러스터 상태 = Git 상태 (Desired State)
```

**ArgoCD의 3가지 핵심 기능**

1. **Auto-Sync**: Git 변경사항을 자동으로 클러스터에 반영
2. **Self-Heal**: 클러스터에서 수동으로 변경한 내용을 Git 상태로 자동 복구
3. **Prune**: Git에서 삭제된 리소스를 클러스터에서도 자동 삭제

## ArgoCD 아키텍처와 컴포넌트

설치 과정에서 마주친 문제들을 이해하기 위해, 먼저 ArgoCD의 아키텍처를 살펴보겠습니다.

**ArgoCD 컴포넌트 구조**

```
┌─────────────────────────────────────────────────────┐
│                  ArgoCD Server                      │  ← API/UI 제공
│  - REST API 제공                                     │
│  - WebUI 제공                                        │
│  - CLI 요청 처리                                     │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│           Application Controller                    │  ← 핵심 컨트롤러
│  - Application 리소스 감시                          │
│  - Git 상태 vs 클러스터 상태 비교                  │
│  - 동기화(Sync) 실행                                │
│  - Health 상태 체크                                 │
└─────────────────────────────────────────────────────┘
          ↓                           ↓
┌──────────────────────┐    ┌──────────────────────┐
│   Repo Server        │    │  Kubernetes API      │
│  - Git clone         │    │  - 리소스 생성/수정   │
│  - Manifest 생성     │    │  - 상태 조회          │
│  - Kustomize build   │    └──────────────────────┘
│  - Helm render       │
└──────────────────────┘
          ↓
┌──────────────────────┐
│   Dex Server         │
│  - SSO/OAuth 인증    │
│  - RBAC 통합         │
└──────────────────────┘
```

**각 컴포넌트의 역할**

1. **API Server (argocd-server)**
    - 사용자 인터페이스(UI, CLI, API) 제공
    - 인증/인가 처리
    - Application 생성/수정 요청 처리
    - 이 컴포넌트가 외부 노출되어야 UI/CLI 접근 가능

2. **Application Controller (argocd-application-controller)**
    - **ArgoCD의 두뇌**
    - Application CRD 리소스를 지속적으로 감시
    - Git 리포지토리 폴링 (기본 3분마다)
    - Desired State(Git)와 Actual State(클러스터) 비교
    - OutOfSync 감지 시 자동 동기화 실행

3. **Repo Server (argocd-repo-server)**
    - Git 리포지토리 연결 및 복제
    - Kustomize, Helm, plain YAML 등 다양한 형식 처리
    - 매니페스트 생성 (kustomize build, helm template 등)
    - **인증 정보(SSH 키, Token)를 여기서 사용**

4. **Dex Server (argocd-dex-server)**
    - SSO/OIDC 연동
    - GitHub, GitLab, Google 등 외부 인증 제공자 통합
    - RBAC 설정과 연동

5. **Redis (argocd-redis)**
    - 캐시 저장소
    - Git 리포지토리 캐시
    - 세션 정보 저장

## 설치 환경

이번 설치는 다음과 같은 제약이 있는 환경에서 진행되었습니다.

**환경 구성**
- **OS**: WSL2 (Windows Subsystem for Linux)
- **Kubernetes**: k3d (Docker 기반 경량 k3s 클러스터)
- **클러스터**: alloy-kafka-dev (단일 서버 노드)
- **도구**: Kustomize (base/overlays 패턴)
- **리포지토리**: Private GitHub repository

**환경의 특수성**
- WSL2는 별도의 가상 네트워크를 사용하여 Windows 호스트와 격리
- k3d는 Docker 컨테이너로 실행되어 일반적인 NodePort 노출이 제한적
- 폐쇄망이 아닌 개발 환경이지만 Private 리포지토리 사용

## Kustomize 기반 구성 전략

ArgoCD 자체도 GitOps로 관리되어야 한다는 원칙에 따라, Kustomize의 base/overlays 패턴을 적용했습니다.

**디렉토리 구조**

```
kustomization/
├── argocd/
│   ├── base/
│   │   ├── kustomization.yaml
│   │   └── namespace.yaml
│   └── overlays/
│       ├── k3d-alloy-kafka-dev/
│       │   └── kustomization.yaml
│       ├── k3d-central/
│       │   └── kustomization.yaml
│       └── production/
│           └── kustomization.yaml
└── applications/
    ├── k3d-alloy-kafka-dev/
    │   ├── app-of-apps.yaml
    │   ├── monitoring-app.yaml
    │   └── fluent-bit-app.yaml
    └── k3d-central/
        └── ...
```

**base 구성**

```yaml
# argocd/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: argocd

resources:
  - namespace.yaml
  - https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

patches:
  - patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: argocd-server
      spec:
        template:
          spec:
            containers:
              - name: argocd-server
                command:
                  - argocd-server
                args:
                  - --insecure
    target:
      kind: Deployment
      name: argocd-server
```

공식 매니페스트를 직접 참조하고, --insecure 옵션으로 개발 환경에 맞게 수정합니다.

```yaml
overlay 구성

# argocd/overlays/k3d-alloy-kafka-dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: argocd

resources:
  - ../../base

patches:
  - target:
      kind: Service
      name: argocd-server
    patch: |-
      - op: replace
        path: /spec/type
        value: LoadBalancer

replicas:
  - name: argocd-server
    count: 1
  - name: argocd-repo-server
    count: 1
  - name: argocd-application-controller
    count: 1
```

환경별로 서비스 타입, 레플리카 수 등을 다르게 설정할 수 있습니다.

설치 과정에서 마주친 문제들

문제 1: ArgoCD Server CrashLoopBackOff

```bash
증상

$ kubectl get pods -n argocd
NAME                             READY   STATUS             RESTARTS
argocd-server-56754b5dc-pm84v    0/1     CrashLoopBackOff   6 (2m ago)
argocd-dex-server-5888d77d45-z   0/1     CrashLoopBackOff   6 (92s ago)

로그 확인

$ kubectl logs -n argocd deployment/argocd-server
Error: unknown command "/usr/local/bin/argocd-server" for "argocd-server"
```

원인 분석

ArgoCD v3.1.9의 Deployment 매니페스트를 살펴보면:

```
spec:
  template:
    spec:
      containers:
        - name: argocd-server
          args:
            - /usr/local/bin/argocd-server  # 원본 매니페스트
```

제가 작성한 patch는:

```
patches:
  - patch: |-
      spec:
        template:
          spec:
            containers:
              - name: argocd-server
                command:
                  - argocd-server
                  - --insecure
```

문제의 핵심: Kubernetes에서 command를 설정하면 원본 args를 완전히 대체하는 것이 아니라, args는 유지된 채로 command가 추가됩니다.
결과적으로:

- 실제 실행된 명령

```
argocd-server --insecure /usr/local/bin/argocd-server
```

/usr/local/bin/argocd-server가 인자처럼 처리되어 "unknown command" 에러가 발생했습니다.

해결 방법

command와 args를 모두 명시적으로 지정:

```
patches:
  - patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: argocd-server
      spec:
        template:
          spec:
            containers:
              - name: argocd-server
                command:
                  - argocd-server
                args:
                  - --insecure
    target:
      kind: Deployment
      name: argocd-server
```

교훈: Kustomize patch를 사용할 때 원본 매니페스트의 구조를 정확히 이해해야 합니다. command와 args의 관계를 명확히 알고 있어야 예상치 못한
동작을 피할 수 있습니다.

문제 2: WSL 환경에서 포트포워딩 실패

증상

```
$ kubectl port-forward svc/argocd-server -n argocd 8080:443
Forwarding from 127.0.0.1:8080 -> 8080

# 다른 터미널에서
$ netstat -tuln | grep 8080
tcp  0  0  127.0.0.1:8080  0.0.0.0:*  LISTEN
```

포트포워딩은 정상 실행되었지만, Windows 브라우저에서 http://localhost:8080 접근 시 연결 실패.

원인 분석: WSL2 네트워크 아키텍처

```
Windows Host (192.168.0.100)
    ↓
┌────────────────────────────────┐
│  WSL2 가상 네트워크            │
│  (192.168.164.143)             │
│                                │
│  kubectl port-forward          │
│    → 127.0.0.1:8080 바인딩    │  ← Windows에서 접근 불가!
│                                │
│  k3d 클러스터                  │
│    → Docker 네트워크           │
└────────────────────────────────┘
```

WSL2는 Hyper-V 기반 가상 네트워크를 사용합니다. kubectl port-forward는 기본적으로 127.0.0.1(localhost)에만 바인딩되는데, 이는 WSL
내부에서만 유효합니다. Windows 호스트의 localhost와는 다른 네트워크 인터페이스입니다.

해결 방법 1: --address 옵션 사용

```
$ kubectl port-forward svc/argocd-server -n argocd 8080:80 --address 0.0.0.0
Forwarding from 0.0.0.0:8080 -> 80

# 이제 모든 인터페이스에서 접근 가능
$ netstat -tuln | grep 8080
tcp  0  0  0.0.0.0:8080  0.0.0.0:*  LISTEN
```

이제 Windows에서 다음 주소로 접근 가능합니다:
- http://localhost:8080 (WSL이 Windows 포트를 자동 포워딩)
- http://192.168.164.143:8080 (WSL IP 직접 접근)

해결 방법 2: LoadBalancer 사용 시도

k3d는 Traefik 기반의 내장 LoadBalancer를 제공합니다.

```
patches:
  - target:
      kind: Service
      name: argocd-server
    patch: |-
      - op: replace
        path: /spec/type
        value: LoadBalancer
```

하지만 k3d의 LoadBalancer는 클러스터 생성 시 포트 매핑이 필요합니다:

```
$ k3d cluster create mycluster -p "8080:80@loadbalancer"
```

이미 생성된 클러스터에서는 재생성 없이 LoadBalancer 포트를 노출할 수 없어, 결국 --address 0.0.0.0 방식을 채택했습니다.

```
kubectl port-forward svc/argocd-server -n argocd 8080:80 --address 0.0.0.0
```

문제 3: Private GitHub Repository 인증 실패

증상

Application을 배포하자 다음 에러 발생:

```
$ kubectl describe application app-of-apps -n argocd
...
Message: Failed to load target state: failed to generate manifest for source 1 of 1:
          rpc error: code = Unknown desc = failed to list refs:
          authentication required: Repository not found.
```

원인 분석: Repo Server의 인증 프로세스

```
Application Controller
    ↓ "Git 상태 가져와"
Repo Server
    ↓ "어떤 Git 주소?"
Application의 spec.source.repoURL 확인
    ↓
Secret 조회 (label: argocd.argoproj.io/secret-type=repository)
    ↓
일치하는 URL의 인증 정보 찾기
    ↓
❌ 인증 정보 없음 → "Repository not found"
```

ArgoCD의 Repo Server는 Git 리포지토리 접근 시 다음 순서로 인증을 시도합니다:

1. argocd.argoproj.io/secret-type=repository 레이블이 있는 Secret 조회
2. Secret의 url 필드와 Application의 repoURL 매칭
3. 매칭되면 해당 Secret의 인증 정보 사용 (SSH 키 또는 Token)
4. 매칭되는 Secret이 없으면 인증 없이 접근 시도 → Private repo는 실패

해결 방법: SSH 키를 통한 인증

1. SSH 키 생성 및 GitHub에 등록

```
$ ssh-keygen -t rsa -C "argocd@k3d"
$ cat ~/.ssh/id_rsa.pub
# GitHub Settings > Deploy keys > Add deploy key에 공개키 등록
```

2. ArgoCD에 SSH 인증 정보 등록

```
$ kubectl create secret generic github-repo-secret \
  --from-file=sshPrivateKey=$HOME/.ssh/id_rsa \
  --namespace argocd

$ kubectl label secret github-repo-secret \
  argocd.argoproj.io/secret-type=repository \
  --namespace argocd

$ kubectl patch secret github-repo-secret \
  --namespace argocd \
  --type merge \
  -p '{"stringData":{"type":"git","url":"git@github.com:dongjangoon/infrastructure-charts.git"}}'
```

Secret의 구조:

```
apiVersion: v1
kind: Secret
metadata:
  name: github-repo-secret
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: git@github.com:dongjangoon/infrastructure-charts.git
data:
  sshPrivateKey: <base64-encoded-private-key>
```

3. Application의 repoURL 형식 일치

여기서 중요한 함정이 있었습니다. 처음 Application을 다음과 같이 작성했습니다:

```
spec:
  source:
    repoURL: https://github.com/dongjangoon/infrastructure-charts.git
```

하지만 Secret에는 SSH URL이 등록되어 있었습니다:

```
Secret: git@github.com:dongjangoon/infrastructure-charts.git
Application: https://github.com/dongjangoon/infrastructure-charts.git
```

URL이 정확히 일치하지 않으면 ArgoCD는 해당 Secret을 찾지 못합니다.

수정:

```
spec:
  source:
    repoURL: git@github.com:dongjangoon/infrastructure-charts.git  # SSH 형식으로 변경
```

ArgoCD의 리포지토리 인증은 URL 문자열 매칭으로 이루어집니다. HTTPS와 SSH는 완전히 다른 URL로 취급되므로, Secret의 URL과
Application의 repoURL이 정확히 일치해야 합니다. 일관성 있게 SSH 또는 HTTPS 중 하나를 선택하여 모든 Application에서 동일한 형식을 사용해야
합니다.

## App of Apps 패턴 구현

실무에서 수십 개의 Application을 관리할 때, 각각을 수동으로 배포하는 것은 비효율적입니다. App of Apps 패턴은 이를 해결하는 ArgoCD의 핵심
패턴입니다.

App of Apps 패턴이란?

```
app-of-apps (Application)
    ↓ Git 리포지토리의 applications/ 디렉토리를 참조
    ↓ 해당 디렉토리에 여러 Application YAML 존재
    ├─ monitoring-app.yaml (Application)
    │    ↓ monitoring/overlays/k3d-alloy-kafka-dev 참조
    │    ↓ Prometheus, Grafana, Jaeger 등 배포
    │
    ├─ fluent-bit-app.yaml (Application)
    │    ↓ fluent-bit/overlays/k3d-alloy-kafka-dev 참조
    │    ↓ Fluent-bit DaemonSet 배포
    │
    └─ (새 Application 추가 시 자동으로 감지 및 배포)
```

App of Apps Application 정의

```
# applications/k3d-alloy-kafka-dev/app-of-apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: app-of-apps
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default

  source:
    repoURL: git@github.com:dongjangoon/infrastructure-charts.git
    targetRevision: main
    path: kustomization/applications/k3d-alloy-kafka-dev  # 이 디렉토리의 모든 Application을 관리

  destination:
    server: https://kubernetes.default.svc
    namespace: argocd

  syncPolicy:
    automated:
      prune: true        # Git에서 삭제된 Application도 클러스터에서 삭제
      selfHeal: true     # 수동 변경 시 자동 복구
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
```

하위 Application 정의

```
# applications/k3d-alloy-kafka-dev/monitoring-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: monitoring
  namespace: argocd
spec:
  project: default

  source:
    repoURL: git@github.com:dongjangoon/infrastructure-charts.git
    targetRevision: main
    path: kustomization/monitoring/overlays/k3d-alloy-kafka-dev

  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

배포

```
# 오직 하나의 Application만 배포
$ kubectl apply -f applications/k3d-alloy-kafka-dev/app-of-apps.yaml

# App of Apps가 자동으로 하위 Application들을 배포
$ kubectl get applications -n argocd
NAME          SYNC STATUS   HEALTH STATUS
app-of-apps   Synced        Healthy
monitoring    Synced        Healthy
fluent-bit    Synced        Healthy
```

App of Apps의 장점

1. 단일 진입점: 한 번의 배포로 모든 Application 관리
2. 선언적 관리: 새 Application을 Git에 추가하기만 하면 자동 배포
3. 환경별 분리: 디렉토리를 나누어 dev/staging/prod 별로 다른 App of Apps 구성
4. GitOps 완성: Application 정의 자체도 Git으로 관리

실제 사용 흐름

```
# 1. 새로운 Application 추가
$ vim applications/k3d-alloy-kafka-dev/elasticsearch-app.yaml
$ git add . && git commit -m "feat: add elasticsearch"
$ git push

# 2. ArgoCD가 자동 감지 (3분 이내)
# 3. app-of-apps가 OutOfSync 감지
# 4. 자동으로 elasticsearch Application 생성 및 배포

# 수동 동기화를 원하면:
$ kubectl patch application app-of-apps -n argocd --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"normal"}}}'
```

ArgoCD의 핵심 설정 값

실무에서 자주 조정하는 설정들을 정리합니다.

1. syncPolicy.automated

```
syncPolicy:
  automated:
    prune: true        # Git에서 삭제 → 클러스터에서도 삭제
    selfHeal: true     # 클러스터 수동 변경 → Git 상태로 복구
    allowEmpty: false  # 빈 디렉토리 동기화 방지
```

- prune: false로 설정하면 Git에서 파일을 삭제해도 클러스터 리소스는 남음 (안전하지만 불일치 발생)
- selfHeal: false로 설정하면 수동 변경이 유지됨 (디버깅 시 유용)
- 실무에서는 production은 automated: false로 하여 수동 승인 후 배포하는 경우도 많음

2. syncOptions

```
syncOptions:
  - CreateNamespace=true       # 네임스페이스 자동 생성
  - PrunePropagationPolicy=foreground  # 삭제 순서 제어
  - PruneLast=true            # 삭제는 마지막에
  - ApplyOutOfSyncOnly=true   # OutOfSync 리소스만 적용
```

- CreateNamespace=true가 없으면 네임스페이스를 미리 생성해야 함
- PruneLast=true는 새 리소스 생성 후 구 리소스 삭제 (Blue-Green 패턴)

3. retry 정책

```
retry:
  limit: 5               # 최대 재시도 횟수
  backoff:
    duration: 5s        # 초기 대기 시간
    factor: 2           # 지수 백오프
    maxDuration: 3m    # 최대 대기 시간
```

네트워크 불안정이나 일시적 오류 시 자동 재시도합니다.

4. Application Controller 설정

```
# argocd-cm ConfigMap
data:
  timeout.reconciliation: 180s  # Git 폴링 주기 (기본 3분)
  application.instanceLabelKey: argocd.argoproj.io/instance  # 리소스 추적용 레이블
```

폴링 주기를 줄이면 빠른 반영이 가능하지만 Git 서버 부하 증가.

5. 리소스 Health 체크

ArgoCD는 리소스 타입별로 Health 판단 기준이 다릅니다:

```
| 리소스 타입      | Healthy 조건                                             |
|-------------|--------------------------------------------------------|
| Deployment  | availableReplicas == replicas                          |
| StatefulSet | readyReplicas == replicas                              |
| Service     | 항상 Healthy                                             |
| Ingress     | loadBalancer.ingress 존재                                |
| Pod         | phase == Running && containerStatuses[*].ready == true |
```

커스텀 CRD는 argocd-cm에서 Health 체크 로직을 정의할 수 있습니다.

## 마치며

Git이 Single Source of Truth가 되면, 인프라 변경의 모든 히스토리가 추적 가능하고, 롤백이 git revert 하나로 가능하며, 리뷰 프로세스를 코드와 동일하게 적용할 수 있습니다.