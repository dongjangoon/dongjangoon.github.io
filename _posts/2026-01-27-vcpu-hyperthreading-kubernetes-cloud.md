---
layout: single
title: "vCPU와 하이퍼스레딩: 물리코어부터 Kubernetes까지"
date: 2026-01-27 11:00:00 +0900
categories: infrastructure
tags: [cpu, vcpu, hyperthreading, smt, kubernetes, cloud, virtualization, performance]
excerpt: "192코어 서버의 vCPU는 몇 개일까? 하이퍼스레딩, 물리코어, 논리코어, vCPU의 관계를 이해하고 Kubernetes와 클라우드 환경에서 CPU 리소스를 제대로 활용하는 방법을 알아봅니다."
---

## 들어가며

"이 서버는 192코어인데 vCPU로는 얼마나 되나요?"

최근 GPU 클러스터를 운영하거나 클라우드 인프라를 다루면서 자주 듣는 질문입니다. 물리코어, 논리코어, vCPU, 하이퍼스레딩... 비슷해 보이지만 각각 다른 의미를 가진 이 개념들을 정확히 이해하지 못하면 리소스 산정에서 실수하기 쉽습니다.

이 글에서는 CPU의 물리적 구조부터 시작해서 하이퍼스레딩이 어떻게 동작하는지, 그리고 Kubernetes와 클라우드 환경에서 CPU를 어떻게 다루는지 살펴보겠습니다.

## CPU 구조의 기본 이해

먼저 CPU 구조를 살펴보고, 하이퍼스레딩, vCPU라는 개념이 왜 나오게 되었는지 보겠습니다.

### 물리코어 (Physical Core)

**물리코어**는 CPU 다이(die) 위에 실제로 존재하는 독립적인 처리 유닛입니다.

```
┌─────────────────────────────────────────┐
│              CPU Package                │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │ Core 0  │ │ Core 1  │ │ Core 2  │   │
│  │         │ │         │ │         │   │
│  │ ALU FPU │ │ ALU FPU │ │ ALU FPU │   │
│  │ L1 L2   │ │ L1 L2   │ │ L1 L2   │   │
│  └─────────┘ └─────────┘ └─────────┘   │
│                                         │
│            L3 Cache (공유)              │
└─────────────────────────────────────────┘
```

각 물리코어는 다음을 포함합니다:
- **ALU (Arithmetic Logic Unit)**: 정수 연산
- **FPU (Floating Point Unit)**: 부동소수점 연산
- **L1/L2 캐시**: 코어 전용 캐시
- **레지스터**: 즉시 접근 가능한 저장 공간

### 코어 내부의 실행 유닛

현대 CPU 코어는 **슈퍼스칼라(Superscalar)** 구조로, 하나의 코어 안에 여러 실행 유닛이 있습니다

```
┌────────────────────────────────────┐
│            Core 내부               │
│                                    │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐      │
│  │ALU │ │ALU │ │FPU │ │Load│      │
│  │ 0  │ │ 1  │ │    │ │Store     │
│  └────┘ └────┘ └────┘ └────┘      │
│                                    │
│  하나의 스레드가 모든 유닛을       │
│  항상 100% 활용하지는 않음         │
└────────────────────────────────────┘
```

문제는 **단일 스레드가 이 모든 실행 유닛을 동시에 활용하지 못한다** 는 점입니다. 메모리 대기, 분기 예측 실패 등으로 인해 실행 유닛이 놀고 있는 시간이 발생합니다.

### Pipeline Stall vs Context Switching

이 현상은 OS의 Context Switching과는 다른 개념입니다.

**Pipeline Stall (실행 유닛 유휴)**

하나의 스레드가 실행 중일 때 CPU 내부에서 발생하는 현상입니다.

```
하나의 스레드 실행 중:

Clock 1: ALU 사용 → 메모리 읽기 요청
Clock 2: (대기) ← cache miss, 메모리에서 데이터 가져오는 중
Clock 3: (대기) ← 아직 대기 (100~300 사이클 소요 가능)
...
Clock N: 데이터 도착 → 다음 명령어 실행

→ 이 대기 시간 동안 ALU, FPU 등 실행 유닛이 놀고 있음
```

원인은 Cache miss (메모리 대기), Branch misprediction (분기 예측 실패), Data dependency (이전 연산 결과 대기) 등입니다.

**Context Switching**

OS가 실행 중인 스레드를 다른 스레드로 교체하는 것입니다.

```
Thread A 실행 중 → 타이머 인터럽트/시스템 콜
                  ↓
         OS 스케줄러 개입
                  ↓
         Thread A 상태 저장 (레지스터, PC 등)
         Thread B 상태 복원
                  ↓
         Thread B 실행
```

레지스터 저장/복원, TLB flush, 캐시 오염 등의 오버헤드가 발생합니다.

**핵심 차이**

| 구분 | Pipeline Stall | Context Switching |
|-----|--------------|-------------------|
| 발생 레벨 | CPU 하드웨어 내부 | OS 커널 |
| 원인 | 메모리 대기, 파이프라인 해저드 | 타이머, I/O, 시스템 콜 |
| 스레드 수 | 1개 스레드 실행 중 | 스레드 교체 |
| 시간 단위 | 수~수백 사이클 | 수천~수만 사이클 |

하이퍼스레딩은 **Pipeline Stall 문제를 해결** 합니다. Thread A가 메모리 대기할 때 OS 개입 없이 하드웨어가 즉시 Thread B의 명령어를 실행 유닛에 넣어서 유휴 시간을 활용합니다.

그럼 하이퍼스레딩에 대해서 좀 더 자세히 알아보겠습니다.

## 하이퍼스레딩 (Hyper-Threading)

### SMT란?

**SMT (Simultaneous Multi-Threading)** 는 하나의 물리코어가 여러 스레드를 동시에 처리할 수 있게 하는 기술입니다. Intel은 이를 **Hyper-Threading Technology (HTT)** 라는 브랜드명으로 부릅니다. 

저도 이번에 찾아보며 알게 되었지만 SMT가 개념이고 하이퍼스레딩은 인텔에서 이 SMT를 구현하며 붙인 이름입니다.

```
┌─────────────────────────────────────────┐
│         SMT 없는 코어 (1C/1T)           │
│                                         │
│  Thread A: ████░░██░░████░░██           │
│            실행  대기 실행  대기         │
│                                         │
│  실행 유닛 활용률: ~50%                  │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│         SMT 있는 코어 (1C/2T)           │
│                                         │
│  Thread A: ████░░██░░████░░██           │
│  Thread B: ░░████░░██░░████░░           │
│            ↓                            │
│  Combined: ██████████████████           │
│                                         │
│  실행 유닛 활용률: ~70-80%               │
└─────────────────────────────────────────┘
```

### 하이퍼스레딩의 원리

위에서 보시다시피 하이퍼스레딩은 코어 전체를 하나 더 사용하는 개념은 아니고, 일부 비어있는 공간을 좀 더 효율적으로 사용합니다.

이를 복제되는 것, 공유되는 것으로 나누어보면 아래와 같습니다.

**복제되는 것 (저렴함)**:
- 아키텍처 상태 (레지스터 세트)
- 프로그램 카운터
- 스택 포인터

**공유되는 것 (비쌈)**:
- 실행 유닛 (ALU, FPU)
- 캐시 (L1, L2)
- 분기 예측기

```
┌─────────────────────────────────────┐
│     하이퍼스레딩 코어 구조          │
│                                     │
│  ┌─────────┐     ┌─────────┐       │
│  │Thread 0 │     │Thread 1 │       │
│  │Registers│     │Registers│       │
│  │   PC    │     │   PC    │       │
│  └────┬────┘     └────┬────┘       │
│       │               │            │
│       └───────┬───────┘            │
│               ▼                    │
│  ┌─────────────────────────┐       │
│  │    공유 실행 유닛       │       │
│  │  ALU  ALU  FPU  Load    │       │
│  └─────────────────────────┘       │
│               │                    │
│  ┌─────────────────────────┐       │
│  │      공유 캐시          │       │
│  └─────────────────────────┘       │
└─────────────────────────────────────┘
```

### SMT 구성 방식

| 구성 | 설명 | 예시 |
|-----|------|-----|
| SMT-2 | 코어당 2스레드 | Intel Core, AMD Ryzen |
| SMT-4 | 코어당 4스레드 | IBM POWER8/9 |
| SMT-8 | 코어당 8스레드 | IBM POWER10 |

대부분의 x86 서버는 **SMT-2**를 사용합니다:

```bash
# 192 물리코어 + SMT-2
192 물리코어 × 2 = 384 논리코어
```

## 물리코어, 논리코어, vCPU 정리

### 용어 정리

| 용어 | 정의 | 확인 방법 |
|-----|------|----------|
| **물리코어** | 실제 하드웨어 코어 수 | `lscpu`의 `Core(s) per socket` × 소켓 수 |
| **논리코어** | OS가 인식하는 CPU 수 | `lscpu`의 `CPU(s)` 또는 `nproc` |
| **vCPU** | 가상화 환경에서 할당된 CPU | 하이퍼바이저/클라우드 정의에 따름 |

### lscpu 출력 해석

```bash
$ lscpu
Architecture:          x86_64
CPU(s):                384        # 논리코어 (OS가 보는 CPU 수)
Thread(s) per core:    2          # SMT-2 (하이퍼스레딩)
Core(s) per socket:    96         # 소켓당 물리코어
Socket(s):             2          # CPU 소켓 수
NUMA node(s):          4          # NUMA 노드 수

# 계산: 96 코어 × 2 소켓 = 192 물리코어
# 계산: 192 물리코어 × 2 스레드 = 384 논리코어
```

### /proc/cpuinfo로 확인

```bash
# 논리코어 수
$ grep -c processor /proc/cpuinfo
384

# 물리코어 수 (고유한 core id 개수)
$ cat /proc/cpuinfo | grep "core id" | sort -u | wc -l
192

# 소켓 수
$ cat /proc/cpuinfo | grep "physical id" | sort -u | wc -l
2
```

## 하이퍼스레딩의 실제 성능

### 2배 코어 ≠ 2배 성능

하이퍼스레딩이 논리코어를 2배로 만들어도 성능이 2배가 되지는 않습니다:

```
┌─────────────────────────────────────────────┐
│         워크로드별 SMT 성능 향상            │
├─────────────────────────────────────────────┤
│                                             │
│  CPU-bound (연산 집약적)                    │
│  ████████████░░░░░░░░  10-30% 향상          │
│                                             │
│  I/O-bound (대기 많음)                      │
│  ████████████████████░░░░  30-50% 향상      │
│                                             │
│  Memory-bound (메모리 대기)                 │
│  ████████████████░░░░░░  20-40% 향상        │
│                                             │
│  혼합 워크로드                              │
│  ████████████████░░░░░░  평균 25-30% 향상   │
│                                             │
└─────────────────────────────────────────────┘
```

### 워크로드별 특성

**SMT가 효과적인 경우:**
- 웹 서버 (I/O 대기 많음)
- 데이터베이스 (락 대기, I/O)
- 컨테이너 오케스트레이션 (다수의 경량 프로세스)

**SMT 효과가 적은 경우:**
- HPC 연산 (CPU 100% 사용)
- 실시간 시스템 (지연 시간 예측 필요)
- 특정 암호화 연산 (보안상 비활성화)

**GPU 워크로드 (LLM 추론 등):**
- CPU는 전처리/후처리 담당
- GPU가 병목이므로 CPU SMT 영향 미미

### SMT 비활성화가 필요한 경우

```bash
# 보안 취약점 (Spectre, MDS 등) 대응
# BIOS에서 비활성화 또는 커널 파라미터

# 커널 파라미터로 비활성화
nosmt=force

# 런타임에 비활성화
echo off > /sys/devices/system/cpu/smt/control
```

## 클라우드 환경의 vCPU

### 클라우드 벤더별 vCPU 정의

모든 주요 클라우드 벤더가 **vCPU = 1 하이퍼스레드**로 정의합니다:

| 클라우드 | vCPU 정의 | 물리코어 환산 |
|---------|----------|--------------|
| AWS EC2 | 1 하이퍼스레드 | 2 vCPU ≈ 1 물리코어 |
| GCP Compute | 1 하이퍼스레드 | 2 vCPU ≈ 1 물리코어 |
| Azure VM | 1 하이퍼스레드 | 2 vCPU ≈ 1 물리코어 |

```
┌─────────────────────────────────────────┐
│        클라우드 vCPU 할당 예시          │
│                                         │
│  물리 서버: 96 코어 × SMT-2 = 192 vCPU  │
│                                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │ VM A    │ │ VM B    │ │ VM C    │   │
│  │ 8 vCPU  │ │ 16 vCPU │ │ 4 vCPU  │   │
│  └─────────┘ └─────────┘ └─────────┘   │
│                                         │
│  실제 물리코어: 4개    8개     2개       │
└─────────────────────────────────────────┘
```

### AWS EC2 인스턴스 예시

```bash
# c5.4xlarge
vCPU: 16
물리코어: 8 (16 ÷ 2)
메모리: 32GB

# 전용 호스트에서 SMT 비활성화 가능
aws ec2 modify-instance-attribute \
    --instance-id i-1234567890abcdef0 \
    --cpu-options "CoreCount=8,ThreadsPerCore=1"
```

### vCPU 오버커밋

가상화 환경에서는 물리 자원보다 더 많은 vCPU를 할당할 수 있습니다:

```
┌─────────────────────────────────────────┐
│           vCPU 오버커밋                 │
│                                         │
│  물리: 192 논리코어                     │
│                                         │
│  VM 1: 64 vCPU  ┐                       │
│  VM 2: 64 vCPU  │                       │
│  VM 3: 64 vCPU  ├─ 총 320 vCPU 할당     │
│  VM 4: 64 vCPU  │  (오버커밋 비율 1.67) │
│  VM 5: 64 vCPU  ┘                       │
│                                         │
│  모든 VM이 동시에 100% 사용하지 않으므로 │
│  적절한 오버커밋은 효율적               │
└─────────────────────────────────────────┘
```

**OpenStack/VMware 기본 오버커밋 비율:**
- CPU: 16:1 (기본값, 조정 가능)
- 메모리: 1.5:1

## Kubernetes에서의 CPU 관리

### CPU 리소스 단위

Kubernetes의 `resources.cpu`는 **논리코어(vCPU)** 기준입니다:

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    resources:
      requests:
        cpu: "2"        # 2 논리코어 (= 2 vCPU)
        memory: "4Gi"
      limits:
        cpu: "4"        # 최대 4 논리코어
        memory: "8Gi"
```

**밀리코어 단위:**
```yaml
resources:
  requests:
    cpu: "500m"    # 0.5 논리코어
  limits:
    cpu: "1500m"   # 1.5 논리코어
```

### 노드의 CPU Capacity

```bash
$ kubectl describe node worker-01

Capacity:
  cpu:                384        # 논리코어 수 (SMT 포함)
  memory:             512Gi
  nvidia.com/gpu:     8

Allocatable:
  cpu:                380        # 시스템 예약분 제외
  memory:             500Gi
  nvidia.com/gpu:     8
```

Kubernetes는 물리코어 개념을 모릅니다. OS가 보고하는 논리 CPU 수를 그대로 사용합니다.

### CPU Manager와 Topology Manager

고성능이 필요한 워크로드에서는 CPU 핀닝과 NUMA 인지 스케줄링이 중요합니다.

CPU 핀닝이란 특정 프로세스나 스레드를 지정한 CPU 코어에서만 실행되도록 고정하는 것으로 Kubernetes의 QoS와 연관이 있습니다.

```yaml
# kubelet 설정 (/var/lib/kubelet/config.yaml)
cpuManagerPolicy: static          # CPU 핀닝 활성화
topologyManagerPolicy: best-effort # NUMA 인지 스케줄링
reservedSystemCPUs: "0-3"         # 시스템용 CPU 예약
```

**CPU Manager 정책**

| 정책 | 동작 |
|-----|-----|
| `none` | 기본값, CFS 스케줄러에 위임 |
| `static` | Guaranteed QoS Pod에 전용 CPU 할당 |

```yaml
# static 정책에서 전용 CPU를 받으려면
# 1. Guaranteed QoS (requests = limits)
# 2. CPU가 정수 단위
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: latency-sensitive-app
    resources:
      requests:
        cpu: "4"        # 정수 단위
        memory: "8Gi"
      limits:
        cpu: "4"        # requests와 동일
        memory: "8Gi"
```

### NUMA 토폴로지 고려

대형 서버에서는 NUMA(Non-Uniform Memory Access) 구조를 이해해야 합니다.

아래와 같은 구조에서 1개 Pod의 프로세스가 다른 NUMA Node에 올라가면 그만큼의 노드 통신 오버헤드가 발생하게 됩니다. 

```
┌─────────────────────────────────────────────┐
│              2소켓 서버 NUMA 구조            │
│                                             │
│  ┌─────────────────┐  ┌─────────────────┐  │
│  │   NUMA Node 0   │  │   NUMA Node 1   │  │
│  │                 │  │                 │  │
│  │  CPU 0-95      │  │  CPU 96-191     │  │
│  │  (48코어×2스레드)│  │  (48코어×2스레드)│  │
│  │                 │  │                 │  │
│  │  Memory 256GB   │  │  Memory 256GB   │  │
│  │                 │  │                 │  │
│  │  GPU 0,1,2,3    │  │  GPU 4,5,6,7    │  │
│  └────────┬────────┘  └────────┬────────┘  │
│           │      QPI/UPI       │           │
│           └────────────────────┘           │
│              (노드 간 통신 느림)            │
└─────────────────────────────────────────────┘
```

**Topology Manager로 NUMA 인지 스케줄링**

```yaml
# kubelet 설정
topologyManagerPolicy: single-numa-node  # 단일 NUMA 노드에 할당
topologyManagerScope: pod                # Pod 단위로 적용
```

이렇게 설정하면 GPU와 CPU가 같은 NUMA 노드에 할당되어 성능이 향상됩니다.


## 트러블슈팅 가이드

성능 테스트나 서비스의 사용량이 많을 때, CPU 사용량이 급증해 CPU를 사용하는 요청들이 밀리는 CPU Throttling은 굉장히 자주 발생합니다.

### 1. CPU Throttling 확인

```bash
# Pod의 CPU throttling 확인
kubectl exec -it <pod> -- cat /sys/fs/cgroup/cpu/cpu.stat

# nr_throttled: throttling 발생 횟수
# throttled_time: 총 throttling 시간 (나노초)
```

limits을 초과하면 CFS 스케줄러가 throttling을 적용합니다.

### 2. CPU 할당 상태 확인

```bash
# 노드의 CPU 할당 현황
kubectl describe node <node> | grep -A 5 "Allocated resources"

# Guaranteed Pod의 CPU 핀닝 확인 (static policy)
kubectl exec -it <pod> -- taskset -p 1
```

### 3. NUMA 불균형 확인

```bash
# 노드에서 NUMA 통계 확인
numastat

# NUMA 노드별 메모리 사용량 불균형이 크면
# Topology Manager 설정 검토 필요
```

## 정리

### 핵심 개념 요약

| 개념 | 정의 | 관계 |
|-----|------|-----|
| 물리코어 | 실제 하드웨어 코어 | 기준 |
| 논리코어 | OS가 인식하는 CPU | 물리코어 × SMT 배수 |
| vCPU | 가상화 환경의 CPU 단위 | 일반적으로 = 논리코어 |

### 환경별 CPU 계산

```
베어메탈 서버 (192코어, SMT-2):
├── 물리코어: 192
├── 논리코어: 384
└── Kubernetes Allocatable: ~380 (시스템 예약 제외)

클라우드 VM (16 vCPU):
├── vCPU: 16
├── 물리코어 환산: ~8
└── 실제 성능: 워크로드에 따라 다름
```

CPU 리소스 관리는 단순히 숫자를 맞추는 것이 아니라, 워크로드 특성과 하드웨어 토폴로지를 함께 고려해야 합니다. 특히 GPU 클러스터에서 LLM을 서빙할 때는 CPU보다 GPU 메모리와 NUMA 배치가 더 중요한 경우가 많습니다.
