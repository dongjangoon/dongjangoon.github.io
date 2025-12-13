---
layout: single
title: "nvidia.com/gpu를 지정하지 않았을 때 발생하는 현상"
date: 2025-12-13 00:00:00 +0000
categories: [kubernetes]
tags: [gpu, nvidia, kubernetes, troubleshooting, device-plugin, container-toolkit]
excerpt: "Kubernetes에서 nvidia.com/gpu를 0으로 설정하거나 지정하지 않았을 때 모든 GPU 카드에 프로세스가 동작하는 문제의 원인과 해결 방법"
---

## 문제

- GPU를 사용하는 Pod에서 GPU를 사용하지 않기 위해 `nvidia.com/gpu: 0`으로 하게 되면 모든 GPU 카드에 프로세스가 동작하는 것이 확인됨
- 실제 컨테이너 이미지에 `NVIDIA_VISIBLE_DEVICES=all`로 지정되어 있음 (이 파라미터는 GPU 카드의 인덱스가 들어감, 1이라면 1번 카드 지정, 빈 값이나 -1이 오면 할당 안함)
- 이럴 때, 모든 GPU 카드 8장에 동일한 프로세스가 동작하는 것이 확인됨

## 원인

그 전에 NVIDIA Container Toolkit과 NVIDIA Device Plugin의 역할을 살펴봐야 합니다. 현재 환경에서는 gpu-operator를 통해 통합 배포되어 있습니다.

### NVIDIA Device Plugin

Kubernetes의 스케줄링 및 리소스 관리를 담당하며, 아래 두 가지 역할을 합니다.

#### 1. GPU 자원 탐지

- **역할**: 노드에 설치된 GPU 카드의 존재와 개수를 감지하여 Kubernetes Control Plane에 `nvidia.com/gpu`라는 확장된 리소스로 보고합니다
- **결과**: Kubernetes 스케줄러가 이 정보를 바탕으로 GPU를 요청한 Pod를 GPU가 있는 노드에 배치합니다

#### 2. GPU 할당 및 격리

- **역할**: Pod가 GPU를 요청하면, 해당 Pod에 사용 가능한 특정 GPU를 할당하고, 그 정보를 컨테이너 런타임에 전달합니다
- **결과**: Pod는 할당받은 GPU만 인식하고 사용할 수 있게 되며, 다른 Pod와의 GPU 자원 충돌을 방지합니다 (**이 과정에서 `NVIDIA_VISIBLE_DEVICES` 환경 변수 설정에 관여함**)

### NVIDIA Container Toolkit

컨테이너 내부에서 GPU 하드웨어에 접근할 수 있도록 환경 설정을 담당합니다. 컨테이너 런타임(docker, containerd 등)이 사용하는 도구입니다.

#### 1. 런타임 제공

- **역할**: GPU를 인식하고 실행할 수 있는 특수한 컨테이너 런타임(흔히 `nvidia-container-runtime`으로 불림)을 제공합니다
- **결과**: 일반 컨테이너 런타임(`runc`)로는 접근 불가능한 GPU 장치에 접근할 수 있게 됩니다

#### 2. GPU 장치 및 라이브러리 마운트

- **역할**: Pod가 GPU를 사용하기 위해 기동될 때, 필요한 GPU 장치 파일과 호스트 머신에 설치된 NVIDIA 드라이버 라이브러리를 컨테이너 내부에 자동으로 마운트합니다
- **결과**: 컨테이너 내부의 CUDA/딥러닝 애플리케이션이 실제 GPU 하드웨어와 통신할 수 있게 됩니다

### 상호작용 과정

1. **Pod 요청**: Pod이 `nvidia.com/gpu: 1`을 요청

2. **Plugin 결정**: NVIDIA Device Plugin이 노드의 1번 GPU를 할당하기로 결정하고, 이 정보를 컨테이너 런타임에 전달합니다

3. **Toolkit 실행**: 컨테이너 런타임은 NVIDIA Container Toolkit을 사용하여 컨테이너를 실행합니다. Toolkit은 전달받은 정보(1번 GPU 사용)에 따라 1번 GPU 장치 파일과 필요한 드라이버 파일을 컨테이너 내부에 마운트합니다

## 문제 발생 과정

위 과정을 통해서 실제 문제 발생 과정에서는 아래와 같은 동작으로 문제가 발생한 것으로 생각됩니다.

### 1. GPU 할당 건너뛰기

Pod의 리소스 스펙에서 `nvidia.com/gpu: 0`이나 GPU를 설정하지 않은 상태로 요청을 보내면 NVIDIA Device Plugin은 **필요한 GPU 개수가 0이므로 GPU를 할당할 필요가 없다**고 판단합니다. 이 과정으로 특정 GPU를 선택하거나 `NVIDIA_VISIBLE_DEVICES`를 결정하는 과정을 건너뜁니다.

### 2. 일반 컨테이너로 인식

이 상태로 할당 정보가 컨테이너 런타임(containerd)로 전달되고, 이 정보에는 GPU 관련 설정이 포함되지 않게 됩니다. 즉, 컨테이너 런타임은 **일반 컨테이너**를 기동하는 방식으로 동작합니다.

### 3. NVIDIA 런타임 적용

하지만, GPU 노드에 있는 containerd의 설정 `config.toml`에서 `default_runtime_name = "nvidia"`라고 설정되어 있어 일반 컨테이너도 런타임 클래스가 "runc"가 아닌 "nvidia"로 설정됩니다.

### 4. 격리 메커니즘 미작동

앞에서 Device Plugin의 **GPU 접근을 막는 격리 메커니즘**이 작동하지 않았기 때문에 이 상태에서는 컨테이너 이미지에 적용된 기본 설정들로 컨테이너가 기동하게 되고, 모든 GPU에 접근이 가능한 상태에서 `NVIDIA_VISIBLE_DEVICES=all`로 동작하게 됩니다.

### 5. 모든 GPU 접근

컨테이너 내부 애플리케이션은 마운트된 모든 GPU를 인식하고, 모든 GPU에 프로세스가 동작하게 됩니다.

## 해결 방법

### 방법 1: 명시적 GPU 리소스 지정

GPU를 사용하는 Pod들에는 확실히 GPU를 사용하도록 명시하기:

```yaml
resources:
  limits:
    nvidia.com/gpu: 1  # 명시적으로 지정
```

### 방법 2: Mutating Webhook 활용

Mutating Webhook 등을 사용해서 GPU를 사용하지 않는 Pod인데 GPU 노드에 뜬다면, `NVIDIA_VISIBLE_DEVICES: ""` 로 환경 변수를 주입하여 해결하는 방법도 존재합니다:

```yaml
env:
  - name: NVIDIA_VISIBLE_DEVICES
    value: ""  # 빈 값으로 GPU 접근 차단
```

## 결론

Kubernetes에서 NVIDIA GPU를 사용할 때는 리소스 요청을 명확히 하는 것이 중요합니다. `nvidia.com/gpu`를 0으로 설정하거나 생략하면 Device Plugin의 격리 메커니즘이 작동하지 않아 의도치 않게 모든 GPU에 접근할 수 있게 됩니다. 이는 GPU 노드의 containerd가 기본적으로 NVIDIA 런타임을 사용하도록 설정되어 있기 때문입니다.
