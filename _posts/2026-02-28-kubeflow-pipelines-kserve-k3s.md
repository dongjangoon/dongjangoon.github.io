---
layout: single
title: "Kubeflow Pipelines와 KServe를 k3s에 올리기 — ML 플랫폼의 두 축을 로컬에서 이해하기"
date: 2026-02-28 10:00:00 +0900
categories: mlops
tags: [kubeflow, kserve, kubeflow-pipelines, knative, istio, k3s, ml-platform, model-serving, wsl2]
excerpt: "ML 플랫폼을 이해하려면 직접 설치해보는 것이 가장 빠릅니다. Kubeflow Pipelines로 학습 파이프라인을 구성하고, KServe로 모델을 서빙하는 과정을 WSL2 k3s 환경에서 처음부터 끝까지 실습합니다. 설치 중 마주친 트러블슈팅 사례와 함께, 두 컴포넌트가 Kubernetes 생태계에서 어떤 위치에 있는지 깊이 있게 살펴봅니다."
---

## 들어가며

ML 엔지니어링을 하다 보면 자연스럽게 두 가지 질문에 부딪힙니다.

> "학습 파이프라인을 어떻게 자동화하지?"
> "학습된 모델을 어떻게 안정적으로 서빙하지?"

Jupyter Notebook에서 모델을 만드는 것까지는 데이터 과학자의 영역이지만, 그 모델이 프로덕션에서 실제 추론 요청을 처리하기까지는 파이프라인 오케스트레이션, 아티팩트 관리, 모델 배포, 오토스케일링이라는 엔지니어링 과제를 넘어야 합니다.

**Kubeflow Pipelines** 와 **KServe** 는 이 두 축을 Kubernetes 네이티브하게 해결하는 도구입니다. Kubeflow Pipelines는 "데이터 로드 → 전처리 → 학습 → 평가"라는 ML 워크플로우를 DAG으로 정의하고, KServe는 학습된 모델을 서버리스하게 서빙합니다.

이 글에서는 WSL2 위의 k3s 클러스터에 두 컴포넌트를 직접 설치하고, 간단한 ML 파이프라인을 실행한 뒤, 학습된 모델을 KServe로 서빙하는 과정까지 다룹니다. 설치 과정에서 실제로 마주친 에러와 해결 과정도 함께 공유합니다.

## 전체 아키텍처

먼저 이 글에서 구축하는 전체 스택을 한눈에 보겠습니다.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          k3s Cluster (WSL2)                          │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    Kubeflow Pipelines 2.15.0                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │ Pipeline │  │  Argo    │  │ Metadata │  │  SeaweedFS   │  │  │
│  │  │ API/UI   │  │ Workflow │  │  Store   │  │  (S3 호환)   │  │  │
│  │  │          │  │Controller│  │ (gRPC)   │  │              │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │  │
│  │  ┌──────────┐  ┌──────────┐                                   │  │
│  │  │  MySQL   │  │ Pipeline │                                   │  │
│  │  │  (메타)  │  │Persistence│                                  │  │
│  │  └──────────┘  └──────────┘                                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                      KServe Stack                              │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐    │  │
│  │  │  KServe  │  │   Knative    │  │    cert-manager      │    │  │
│  │  │Controller│  │   Serving    │  │    (TLS 인증서)       │    │  │
│  │  │ (v0.15.1)│  │  (v1.17.0)   │  │    (v1.17.1)         │    │  │
│  │  └──────────┘  └──────────────┘  └──────────────────────┘    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    Istio Service Mesh                          │  │
│  │           (Ingress Gateway + mTLS + Traffic Routing)           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│                         Kubernetes (k3s v1.34)                       │
└──────────────────────────────────────────────────────────────────────┘
```

의존성 관계를 정리하면 이렇습니다.

```
KServe ──▶ Knative Serving ──▶ Istio (네트워킹)
                              ──▶ cert-manager (TLS)

Kubeflow Pipelines ──▶ Argo Workflows (워크플로우 엔진)
                     ──▶ MySQL (메타데이터)
                     ──▶ SeaweedFS (아티팩트 스토리지)
```

KServe가 왜 Knative와 Istio에 의존하는지 궁금하실 수 있습니다. KServe의 핵심 기능인 **서버리스 오토스케일링(Scale-to-zero)** 과 **Canary 배포** 는 Knative Serving의 Revision 관리와 Istio의 트래픽 라우팅 위에서 동작합니다. KServe는 ML 모델 서빙에 특화된 추상화 계층이고, 그 아래의 두 플랫폼이 실제 인프라 수준의 무거운 작업을 담당하는 구조입니다.

## Kubeflow Pipelines — ML 워크플로우 오케스트레이션

### Kubeflow Pipelines가 하는 일

Kubeflow Pipelines(이하 KFP)는 ML 워크플로우를 **DAG(Directed Acyclic Graph)** 으로 정의하고 실행하는 오케스트레이션 플랫폼입니다. "데이터 로드 → 전처리 → 학습 → 평가"라는 흐름을 코드로 선언하면, 각 단계가 독립된 컨테이너(Pod)로 실행됩니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kubeflow Pipelines                            │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Pipeline   │───▶│ Argo Workflow │───▶│   Pods       │       │
│  │   Compiler   │    │  Controller   │    │ (Components) │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                    │                   │               │
│         ▼                    ▼                   ▼               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Pipeline   │    │   Metadata   │    │   Artifact   │       │
│  │   Store (DB) │    │    Store     │    │    Store     │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │                    Pipeline UI                        │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

KFP의 내부 엔진은 **Argo Workflows** 입니다. Argo Workflows 자체는 범용 워크플로우 엔진이고, KFP는 여기에 ML에 특화된 추상화를 얹은 것입니다. 이미 Argo Workflows나 ArgoCD를 운영해본 경험이 있다면, KFP의 인프라 레이어는 익숙하게 느껴질 겁니다.

| Argo Workflows | Kubeflow Pipelines |
|----------------|-------------------|
| 범용 워크플로우 엔진 | ML 워크플로우 특화 |
| YAML로 직접 작성 | Python SDK (`kfp`) |
| 단순 실행 추적 | Artifact/Metadata 자동 추적 |
| — | 실험 비교 UI |

### 핵심 개념 네 가지

KFP를 처음 접할 때 알아야 할 네 가지 개념이 있습니다.

**Pipeline**: ML 워크플로우의 전체 DAG입니다. Python SDK로 정의하면 YAML로 컴파일되어 Argo Workflow로 변환됩니다.

**Component**: Pipeline의 단일 스텝입니다. 각 Component는 독립된 컨테이너(Pod)로 실행되며, 입출력 인터페이스가 정의되어 있어 다른 Pipeline에서도 재사용할 수 있습니다.

**Run**: Pipeline의 실행 인스턴스입니다. 특정 파라미터 세트로 Pipeline을 실행한 결과이며, UI에서 모니터링하고 비교할 수 있습니다.

**Experiment**: Run들의 논리적 그룹입니다. "learning_rate=0.01과 0.001 중 어느 것이 나은가?" 같은 실험을 체계적으로 관리할 수 있습니다.

### MinIO에서 SeaweedFS로

KFP 2.15.0에서 하나 주목할 변화가 있습니다. 아티팩트 저장소가 **MinIO에서 SeaweedFS로 교체** 되었습니다.

SeaweedFS는 S3 호환 API를 제공하면서도 MinIO보다 메모리 사용량이 작은 경량 오브젝트 스토리지입니다. Pipeline Component 간 데이터(Dataset, Model, Metrics 등)를 주고받을 때 이 아티팩트 스토리지를 경유합니다. Component A가 학습 데이터를 CSV로 저장하면 SeaweedFS에 업로드되고, Component B가 이를 다운로드해서 사용하는 방식입니다.

## k3s에 Kubeflow Pipelines 설치하기

### 환경

- **OS**: WSL2 + AlmaLinux 9.6
- **K8s**: k3s v1.34.3
- **메모리**: 24GB (WSL에 할당)
- **기존 인프라**: Istio 서비스 메시 구축 완료

### 설치

KFP Standalone은 kustomize 매니페스트로 설치합니다.

```bash
export PIPELINE_VERSION=2.15.0

# 1. 클러스터 스코프 리소스 (CRD 등)
kubectl apply -k \
  "github.com/kubeflow/pipelines/manifests/kustomize/cluster-scoped-resources?ref=$PIPELINE_VERSION"

# CRD가 등록될 때까지 대기
kubectl wait --for condition=established --timeout=60s crd/applications.app.k8s.io

# 2. KFP 본체 설치 (dev 프로파일)
kubectl apply -k \
  "github.com/kubeflow/pipelines/manifests/kustomize/env/dev?ref=$PIPELINE_VERSION"
```

`env/dev`는 GCP 전용 컴포넌트가 빠진 가벼운 개발용 프로파일입니다. 로컬 환경에서는 이것으로 충분합니다.

설치가 완료되면 `kubeflow` 네임스페이스에 12개 이상의 Pod가 뜹니다.

```
$ kubectl get pods -n kubeflow

cache-deployer-deployment-...       Running
cache-server-...                    Running
controller-manager-...              Running
metadata-envoy-deployment-...       Running
metadata-grpc-deployment-...        Running
metadata-writer-...                 Running
ml-pipeline-...                     Running
ml-pipeline-persistenceagent-...    Running
ml-pipeline-scheduledworkflow-...   Running
ml-pipeline-ui-...                  Running
ml-pipeline-viewer-crd-...          Running
ml-pipeline-visualizationserver-... Running
mysql-...                           Running
seaweedfs-...                       Running
```

그런데 실제로 해보면 한 번에 깔끔하게 되지는 않습니다. 제가 마주친 문제들을 공유합니다.

### 트러블슈팅 1: metadata-grpc CrashLoopBackOff

설치 직후 `metadata-grpc-deployment` Pod가 CrashLoopBackOff에 빠졌습니다.

```
MySQL database was not initialized
```

**원인**: MySQL 8.4 Pod는 Running 상태이지만, 내부적으로 스키마 생성과 권한 설정이 아직 끝나지 않은 상태에서 metadata-grpc가 연결을 시도한 것입니다. Kubernetes에서 흔한 "서비스 간 시작 순서" 문제입니다.

**해결**: MySQL 초기화가 끝난 뒤 metadata-grpc를 재시작하면 정상화됩니다.

```bash
# MySQL 로그에서 "ready for connections" 확인 후
kubectl rollout restart deployment/metadata-grpc-deployment -n kubeflow
```

프로덕션이라면 Init Container나 readiness probe로 선제적으로 해결하겠지만, 로컬 실습에서는 이 정도면 충분합니다.

### 트러블슈팅 2: proxy-agent가 GCP 메타데이터 서버에 접속 시도

```
Get "http://metadata.google.internal/...": dial tcp: lookup metadata.google.internal: no such host
```

`proxy-agent`라는 Pod가 GCP 메타데이터 서버에 접근하려다 실패하고 있었습니다. 이름에서 짐작하듯 GCP 환경 전용 컴포넌트입니다. 로컬 k3s에서는 필요 없으니 꺼주면 됩니다.

```bash
kubectl scale deployment proxy-agent -n kubeflow --replicas=0
```

## ML 파이프라인 작성 및 실행

### Python SDK로 Pipeline 정의하기

이제 실제로 파이프라인을 만들어 보겠습니다. KFP SDK(v2)의 `@dsl.component`와 `@dsl.pipeline` 데코레이터를 사용합니다. Iris 데이터셋으로 간단한 분류 모델을 학습하는 4단계 파이프라인입니다.

먼저 데이터를 로드하는 Component입니다.

```python
from kfp import dsl, compiler
from kfp.dsl import Input, Output, Dataset, Model, Metrics


@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["pandas", "scikit-learn"]
)
def load_data(output_data: Output[Dataset]):
    """데이터 로드"""
    import pandas as pd
    from sklearn.datasets import load_iris

    iris = load_iris(as_frame=True)
    df = iris.frame
    df.to_csv(output_data.path, index=False)
    output_data.metadata["num_samples"] = len(df)
    output_data.metadata["num_features"] = len(iris.feature_names)
    print(f"Loaded {len(df)} samples with {len(iris.feature_names)} features")
```

여기서 `Output[Dataset]`이 핵심입니다. KFP가 SeaweedFS 경로를 자동으로 할당하고, 다음 Component의 `Input[Dataset]`으로 전달해줍니다. 개발자가 직접 스토리지 경로를 관리할 필요가 없습니다.

전처리 Component는 하나의 입력을 받아 두 개의 출력(train/test)을 만듭니다.

```python
@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["pandas", "scikit-learn"]
)
def preprocess_data(
    input_data: Input[Dataset],
    train_data: Output[Dataset],
    test_data: Output[Dataset],
    test_size: float = 0.2,
):
    """train/test 분리"""
    import pandas as pd
    from sklearn.model_selection import train_test_split

    df = pd.read_csv(input_data.path)
    X = df.drop("target", axis=1)
    y = df["target"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42
    )

    train_df = pd.concat([X_train, y_train], axis=1)
    test_df = pd.concat([X_test, y_test], axis=1)
    train_df.to_csv(train_data.path, index=False)
    test_df.to_csv(test_data.path, index=False)

    train_data.metadata["num_samples"] = len(train_df)
    test_data.metadata["num_samples"] = len(test_df)
```

학습 Component에서는 모델 직렬화에 `joblib`을 사용합니다. scikit-learn이 공식적으로 권장하는 직렬화 방식입니다.

```python
@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["pandas", "scikit-learn", "joblib"]
)
def train_model(
    train_data: Input[Dataset],
    model_output: Output[Model],
    learning_rate: float = 0.01,
    max_iter: int = 200,
):
    """LogisticRegression 학습"""
    import pandas as pd
    import joblib
    from sklearn.linear_model import LogisticRegression

    df = pd.read_csv(train_data.path)
    X = df.drop("target", axis=1)
    y = df["target"]

    model = LogisticRegression(
        C=1 / learning_rate, max_iter=max_iter, random_state=42
    )
    model.fit(X, y)
    joblib.dump(model, model_output.path)

    train_acc = model.score(X, y)
    model_output.metadata["train_accuracy"] = float(train_acc)
    model_output.metadata["framework"] = "sklearn"
```

평가 Component는 `Output[Metrics]`를 사용해서 정확도, 정밀도, 재현율을 기록합니다. 이 메트릭은 KFP UI에서 시각화됩니다.

```python
@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["pandas", "scikit-learn", "joblib"]
)
def evaluate_model(
    model_input: Input[Model],
    test_data: Input[Dataset],
    metrics_output: Output[Metrics],
) -> float:
    """정확도, 정밀도, 재현율 평가"""
    import pandas as pd
    import joblib
    from sklearn.metrics import accuracy_score, precision_score, recall_score

    model = joblib.load(model_input.path)
    df = pd.read_csv(test_data.path)
    X = df.drop("target", axis=1)
    y = df["target"]
    y_pred = model.predict(X)

    accuracy = accuracy_score(y, y_pred)
    precision = precision_score(y, y_pred, average="weighted")
    recall = recall_score(y, y_pred, average="weighted")

    metrics_output.log_metric("accuracy", float(accuracy))
    metrics_output.log_metric("precision", float(precision))
    metrics_output.log_metric("recall", float(recall))
    return float(accuracy)
```

마지막으로 Pipeline을 정의하고 Component들을 연결합니다.

```python
@dsl.pipeline(
    name="Simple ML Pipeline",
    description="Iris classification: load → preprocess → train → evaluate",
)
def simple_ml_pipeline(
    learning_rate: float = 0.01,
    test_size: float = 0.2,
    max_iter: int = 200,
):
    load_task = load_data()

    preprocess_task = preprocess_data(
        input_data=load_task.outputs["output_data"],
        test_size=test_size,
    )

    train_task = train_model(
        train_data=preprocess_task.outputs["train_data"],
        learning_rate=learning_rate,
        max_iter=max_iter,
    )

    evaluate_model(
        model_input=train_task.outputs["model_output"],
        test_data=preprocess_task.outputs["test_data"],
    )
```

`preprocess_task`가 `load_task.outputs["output_data"]`를 참조하는 것만으로 DAG의 의존성이 자동 설정됩니다. KFP가 이 관계를 분석해서 올바른 실행 순서를 보장해줍니다.

### 컴파일 및 제출

```python
if __name__ == "__main__":
    # YAML로 컴파일 (Argo Workflow YAML 생성)
    compiler.Compiler().compile(simple_ml_pipeline, "simple_ml_pipeline.yaml")

    # KFP API로 직접 제출
    import kfp
    client = kfp.Client(host="http://localhost:8888")

    run = client.create_run_from_pipeline_func(
        simple_ml_pipeline,
        arguments={"learning_rate": 0.01, "test_size": 0.2, "max_iter": 200},
        experiment_name="ml-interview-prep",
    )
    print(f"Run URL: http://localhost:8080/#/runs/details/{run.run_id}")
```

### 제출 후 내부에서 일어나는 일

Pipeline이 제출되면 내부적으로 이런 흐름이 진행됩니다.

```
Python Pipeline 정의
       │
       ▼ (kfp compiler)
Argo Workflow YAML
       │
       ▼ (KFP API Server)
Argo Workflow CR 생성
       │
       ▼ (Argo Workflow Controller)
Component별 Pod 생성
       │
       ├── load_data Pod
       │     └── 실행 → Output을 SeaweedFS에 업로드
       │
       ├── preprocess_data Pod (load_data 완료 후)
       │     └── SeaweedFS에서 Input 다운로드 → 실행 → Output 업로드
       │
       ├── train_model Pod (preprocess 완료 후)
       │     └── train_data 다운로드 → 학습 → model 업로드
       │
       └── evaluate_model Pod (train 완료 후)
             └── model + test_data 다운로드 → 평가 → metrics 기록
```

각 Component Pod에는 사용자 코드를 실행하는 **main** 컨테이너와, SeaweedFS와의 데이터 업로드/다운로드를 담당하는 **launcher** sidecar가 함께 뜹니다. 개발자는 이 복잡함을 몰라도 됩니다 — `Input[Dataset]`과 `Output[Dataset]`만 선언하면 KFP가 나머지를 처리해줍니다.

### 트러블슈팅 3: argoexec runAsNonRoot 에러

Pipeline을 제출했더니 Pod가 시작되지 않았습니다.

```
container has runAsNonRoot and image will run as root
```

**원인**: k3s v1.34의 보안 정책과 Argo Workflow executor(`argoexec:v3.7.3`)가 충돌한 것입니다. argoexec는 root로 실행되어야 하지만, Pod의 securityContext가 이를 거부하고 있었습니다.

**해결**: workflow-controller-configmap에서 executor의 securityContext를 오버라이드합니다.

```bash
kubectl patch configmap workflow-controller-configmap -n kubeflow \
  --type merge \
  -p '{"data": {"executor": "imagePullPolicy: IfNotPresent\nsecurityContext:\n  runAsNonRoot: false\n  runAsUser: 0\n"}}'

kubectl rollout restart deployment/workflow-controller -n kubeflow
```

### 트러블슈팅 4: SeaweedFS S3 포트 매핑 문제

다시 실행했더니 이번에는 launcher가 타임아웃으로 실패했습니다.

```
dial tcp 10.43.x.x:9000: i/o timeout
```

**원인**: launcher가 SeaweedFS에 S3 프로토콜(포트 9000)로 접근하려 했는데, SeaweedFS Service에는 포트 9000이 정의되어 있지 않았습니다. 실제 S3 API는 포트 8333에서 돌고 있었습니다. `minio-service`라는 호환 Service가 9000→8333 매핑을 하고 있었지만, launcher는 `seaweedfs`라는 호스트명을 사용하고 있어서 매칭이 안 된 것입니다.

KFP 2.x에서 MinIO→SeaweedFS 전환 과도기에 생긴 호환성 이슈로 보입니다.

**해결**: SeaweedFS Service에 포트 9000→8333 매핑을 추가합니다.

```bash
kubectl patch svc seaweedfs -n kubeflow --type='json' \
  -p='[{"op": "add", "path": "/spec/ports/-",
        "value": {"name": "s3-compat", "port": 9000,
                  "protocol": "TCP", "targetPort": 8333}}]'
```

### 실행 결과

모든 트러블슈팅을 해결하고 다시 실행하면, 파이프라인이 성공적으로 완료됩니다.

```
load_data     → 150 samples, 4 features
preprocess    → Train: 120, Test: 30
train_model   → Train accuracy: 0.9750
evaluate      → Accuracy: 1.0000, Precision: 1.0000, Recall: 1.0000
```

KFP UI(http://localhost:8080)에서 DAG 시각화, 각 Component의 로그, 그리고 Artifact(Dataset, Model, Metrics)를 확인할 수 있습니다.

## KServe — 서버리스 모델 서빙

### KServe가 하는 일

지금까지 Kubeflow Pipelines로 모델을 **학습**했습니다. 이제 학습된 모델을 **서빙**할 차례입니다. KServe는 `InferenceService`라는 단일 CRD로 모델 배포, 오토스케일링, Canary 배포를 선언적으로 관리합니다.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        InferenceService                              │
│                                                                      │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐        │
│  │  Transformer  │───▶│   Predictor   │───▶│   Explainer   │        │
│  │  (전처리)      │    │  (추론)        │    │  (설명)        │        │
│  └───────────────┘    └───────────────┘    └───────────────┘        │
│                                                                      │
│                       Knative Serving                                │
│                 (Autoscaling, Revision, Traffic Split)               │
│                                                                      │
│                       Istio Service Mesh                             │
│                   (Ingress, mTLS, Routing)                           │
└─────────────────────────────────────────────────────────────────────┘
```

InferenceService는 세 가지 구성요소를 가질 수 있습니다.
- **Predictor**: 핵심 추론 로직 (필수)
- **Transformer**: 전처리/후처리 (선택)
- **Explainer**: 모델 설명 (선택)

대부분의 경우 Predictor만 사용합니다.

### Built-in Serving Runtimes

KServe는 주요 ML 프레임워크를 위한 런타임을 기본 제공합니다. `modelFormat`에 프레임워크 이름만 지정하면 적절한 `ClusterServingRuntime`이 자동으로 매칭됩니다.

| Runtime | 용도 |
|---------|------|
| **kserve-sklearnserver** | Scikit-learn 모델 |
| **kserve-lgbserver** | LightGBM |
| **kserve-xgbserver** | XGBoost |
| **kserve-pytorchserver** | PyTorch (TorchServe 기반) |
| **kserve-tritonserver** | NVIDIA Triton (멀티프레임워크) |
| **kserve-huggingfaceserver** | HuggingFace Transformers |

### k3s에 KServe 설치하기

KServe 설치는 의존성 순서를 지켜야 합니다: cert-manager → Knative Serving → KServe.

```bash
# 1. cert-manager (Webhook용 TLS 인증서 관리)
kubectl apply -f \
  https://github.com/cert-manager/cert-manager/releases/download/v1.17.1/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=120s

# 2. Knative Serving (서버리스 플랫폼)
kubectl apply -f \
  https://github.com/knative/serving/releases/download/knative-v1.17.0/serving-crds.yaml
kubectl apply -f \
  https://github.com/knative/serving/releases/download/knative-v1.17.0/serving-core.yaml

# Knative + Istio 네트워킹 연동
kubectl apply -f \
  https://github.com/knative/net-istio/releases/download/knative-v1.17.0/net-istio.yaml

# 3. KServe 본체
kubectl apply -f \
  https://github.com/kserve/kserve/releases/download/v0.15.1/kserve.yaml
kubectl wait --for=condition=Available \
  deployment/kserve-controller-manager -n kserve --timeout=120s

# ClusterServingRuntime 등록 (sklearn, pytorch, triton 등)
kubectl apply -f \
  https://github.com/kserve/kserve/releases/download/v0.15.1/kserve-cluster-resources.yaml
```

한 가지 주의할 점: `kserve-cluster-resources.yaml`을 적용할 때 **webhook이 아직 준비되지 않아 실패** 할 수 있습니다. KServe controller Pod가 완전히 Running 상태가 된 후 재시도하면 됩니다.

### InferenceService 배포

sklearn Iris 모델을 서빙해보겠습니다. KServe 공식 예시 모델을 사용합니다.

```yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: sklearn-iris
  namespace: default
spec:
  predictor:
    model:
      modelFormat:
        name: sklearn
      storageUri: "gs://kfserving-examples/models/sklearn/1.0/model"
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
```

YAML이 정말 간결합니다. `storageUri`에 모델 경로를 지정하면, KServe의 **Storage Initializer** Init Container가 모델을 자동으로 다운로드합니다. S3, GCS, Azure Blob, PVC, HTTP 등 다양한 스토리지 백엔드를 지원합니다.

```bash
kubectl apply -f sklearn-iris-isvc.yaml

# 상태 확인
kubectl get inferenceservice sklearn-iris

NAME           URL                                             READY   LATEST   AGE
sklearn-iris   http://sklearn-iris.default.svc.cluster.local   True    100      2m
```

`READY: True`가 되면 서빙 준비가 완료된 것입니다.

### 추론 요청 보내기

```bash
kubectl run curl-test --rm -i --restart=Never --image=curlimages/curl -- \
  curl -s -X POST \
  http://sklearn-iris-predictor.default.svc.cluster.local/v1/models/sklearn-iris:predict \
  -H "Content-Type: application/json" \
  -d '{"instances": [[6.8, 2.8, 4.8, 1.4], [6.0, 3.4, 4.5, 1.6]]}'
```

```json
{"predictions": [1, 1]}
```

Iris 데이터셋의 class 1(Versicolor)로 정확하게 분류되었습니다.

### kubectl apply 한 줄 뒤에서 일어나는 일

InferenceService YAML을 apply하면, 내부적으로 상당히 많은 작업이 자동으로 진행됩니다.

```
InferenceService CR 생성
       │
       ▼ (KServe Controller)
Knative Service 생성
       │
       ├── Storage Initializer (Init Container)
       │     └── storageUri에서 모델 다운로드
       │
       ├── Predictor Container (kserve-sklearnserver)
       │     └── 모델 로드 → HTTP 서버 시작
       │
       ▼ (Knative Serving)
Revision 생성 + Autoscaler 설정
       │
       ▼ (Istio)
VirtualService + Gateway 자동 구성
       │
       ▼
추론 요청 수신 가능
```

vLLM을 직접 Deployment로 배포할 때는 이 과정을 수동으로 구성해야 합니다(Deployment → Service → HPA → Istio VirtualService). KServe는 이 전체를 InferenceService 하나로 추상화합니다.

## KServe vs vLLM 직접 배포

KServe의 편리함을 봤으니, "그럼 항상 KServe를 쓰면 되는 거 아닌가?"라는 생각이 들 수 있습니다. 결론부터 말하면, **상황에 따라 다릅니다**.

| 관점 | KServe | vLLM 직접 배포 |
|------|--------|---------------|
| **인프라 복잡도** | 높음 (Knative, Istio 필수) | 낮음 (K8s 기본 리소스) |
| **리소스 오버헤드** | ~2Gi 추가 메모리 | 없음 |
| **배포 선언** | InferenceService CRD | Deployment + Service |
| **Canary 배포** | 내장 (canaryTrafficPercent) | Istio VirtualService 직접 구성 |
| **Autoscaling** | Knative KPA (동시성 기반) | K8s HPA (커스텀 메트릭) |
| **Scale-to-zero** | 지원 | 미지원 (HPA min=1) |
| **vLLM 파라미터** | 제한적 (Runtime 수정 필요) | 완전 제어 |

### vLLM 직접 배포가 맞는 경우

대규모 트래픽과 엄격한 SLA가 요구되는 환경이라면 vLLM 직접 배포가 유리합니다. `tensor_parallel_size`, `chunked_prefill`, `prefix_caching`, `speculative_decoding` 같은 세밀한 파라미터를 완전히 제어할 수 있고, Knative/KServe 없이 지연시간을 최소화할 수 있습니다.

### KServe가 맞는 경우

다양한 모델(sklearn, pytorch, triton 등)을 통합 관리해야 하거나, 개발 환경에서 Scale-to-zero로 비용을 줄이고 싶을 때, 또는 표준화된 MLOps 파이프라인이 필요할 때 KServe가 적합합니다.

### 현실적인 접근

실무에서는 **하이브리드 접근**이 많습니다. 핵심 LLM 모델은 vLLM 직접 배포로 성능을 극대화하고, 보조 모델(분류, 임베딩, 스코어링 등)은 KServe로 관리 편의성을 확보하는 식입니다.

## Scale-to-zero와 GPU 모델

KServe의 대표 기능 중 하나인 **Scale-to-zero** 에 대해 조금 더 이야기해보겠습니다.

Knative Serving은 요청이 없으면 Pod를 0개로 줄이고, 요청이 들어오면 자동으로 생성합니다.

```
요청 없음: Pod 0개 (비용 0)
       │
       ▼ (요청 도착)
Activator가 요청을 버퍼링하며 대기
       │
       ▼ (Autoscaler가 Pod 생성)
Pod 시작 → 모델 로드 → 요청 처리
       │
       ▼ (일정 시간 요청 없음)
Pod 0개로 축소
```

매력적인 기능이지만, **GPU 모델에서는 신중해야 합니다**. 대규모 LLM 모델의 cold start는 모델을 GPU 메모리에 로드하는 데만 수십 초에서 수 분이 걸리기 때문입니다.

프로덕션에서는 현실적으로 다음과 같이 설정합니다.

```yaml
metadata:
  annotations:
    autoscaling.knative.dev/minScale: "1"    # 최소 1개 Pod 항상 유지
    autoscaling.knative.dev/maxScale: "5"    # 최대 5개까지 확장
    autoscaling.knative.dev/target: "10"     # 동시 요청 10개 기준 스케일
```

비용 최적화가 필요하다면 Scale-to-zero보다는 적절한 인스턴스 사이징, 시간대별 스케줄링(업무 외 시간 축소), 또는 스팟 인스턴스 활용이 더 효과적입니다.

## 마치며

WSL2 k3s 환경에서 Kubeflow Pipelines와 KServe를 설치하고, ML 파이프라인 실행부터 모델 서빙까지 한 사이클을 돌아봤습니다.

정리하면 이렇습니다.

**Kubeflow Pipelines** 는 Argo Workflows 위에서 ML 워크플로우를 Python SDK로 추상화합니다. Component 간 데이터 전달, 메타데이터 추적, 실험 비교를 자동화해주고, 개발자는 각 Component의 비즈니스 로직에만 집중할 수 있습니다.

**KServe** 는 Knative Serving + Istio 위에서 모델 서빙을 선언적으로 관리합니다. InferenceService YAML 하나로 모델 배포, 오토스케일링, Canary 배포를 할 수 있으며, 다양한 ML 프레임워크를 Built-in Runtime으로 지원합니다.

두 컴포넌트 모두 **Kubernetes CRD 기반** 으로 설계되어 있어, 기존 Kubernetes 인프라(Istio, Prometheus, ArgoCD 등)와 자연스럽게 통합됩니다. 이미 Kubernetes를 운영하고 있다면, ML 플랫폼으로의 확장이 상대적으로 수월합니다.

설치 과정에서 마주친 문제들(MySQL 초기화 순서, SeaweedFS 포트 매핑, Argo executor securityContext)은 Kubernetes 기반 플랫폼에서 흔히 겪는 유형입니다. 에러 메시지를 잘 읽고 컴포넌트 간 의존성을 이해하면 대부분 해결할 수 있습니다.

이 두 컴포넌트를 이해하면 ML 라이프사이클의 "학습 → 서빙" 전체 그림이 보이기 시작합니다. Kubeflow Pipelines가 학습을 오케스트레이션하고, KServe가 서빙을 담당하며, 그 사이를 Model Registry가 연결하는 구조 — 이것이 현대 ML 플랫폼의 전형적인 패턴입니다.

```
데이터 ──▶ Kubeflow Pipelines ──▶ Model Registry ──▶ KServe ──▶ 추론 요청
          (학습 파이프라인)         (모델 저장소)       (모델 서빙)
```
