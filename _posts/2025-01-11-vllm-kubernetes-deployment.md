---
layout: single
title: "k3s에서 vLLM GPU 서빙 환경 구축하기"
date: 2025-01-11 00:00:00 +0000
categories: [infrastructure, kubernetes]
tags: [vllm, kubernetes, k3s, gpu, nvidia, llm, deployment, container-toolkit]
excerpt: "k3s 클러스터에서 RTX 5070 Ti GPU를 활용한 vLLM 배포 가이드입니다. NVIDIA Container Toolkit 설정부터 모니터링까지 전체 과정을 다룹니다."
---

## 들어가며

LLM을 프로덕션에 배포할 때 Kubernetes는 자연스러운 선택입니다. 스케일링, 헬스 체크, 롤링 업데이트 등 운영에 필요한 기능을 제공하기 때문입니다. 저는 Kubernetes 환경이 익숙하기도 하고, 이 환경에서의 LLM 서빙 및 동작에 대해 학습하기 위해서 Kubernetes 그리고 아래와 같은 환경을 선택했습니다.

이 글에서는 **k3s** 환경에서 **NVIDIA GPU**를 활용한 **vLLM** 배포 과정을 처음부터 끝까지 다룹니다. WSL2 + AlmaLinux 9(CentOS 기반) 환경을 기준으로 하지만, 일반 Linux 환경에서도 유사하게 적용할 수 있습니다.

## 환경 정보

```
OS: WSL2 + AlmaLinux 9
GPU: NVIDIA RTX 5070 Ti (16GB VRAM)
Kubernetes: k3s v1.34.3+k3s1
Container Runtime: containerd + nvidia-container-runtime
NVIDIA Container Toolkit: 1.18+
CUDA Driver: 591.59 (CUDA 13.1)
```

## k3s + GPU 클러스터 구성

### k3s 설치

물론 실제 프로덕션 환경에서 k3s, WSL 환경으로 Kubernetes, GPU 환경을 구성하지는 않습니다만, 이 환경은 학습용이기도 하고, 빠른 환경 구성을 위해 이와 같은 환경 구성을 택했습니다. WSL도 그렇지만, mac, linux에서도 kind, k3s, k3d, kubespray 등의 Kubernetes 설치 도구들은 굉장히 쉽게 Kubernetes 환경을 구성할 수 있게 해줍니다.

```bash
# k3s 설치 (traefik 비활성화)
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_SKIP_SELINUX_RPM=true \
  INSTALL_K3S_SELINUX_WARN=true \
  INSTALL_K3S_EXEC="--disable=traefik" sh -

# kubeconfig 설정
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
```

Traefik을 비활성화하는 이유:
- GPU 작업에 리소스 집중
- 필요 시 원하는 네트워크(Ingress/Gateway) 컴포넌트를 선택하여 구성

### NVIDIA Container Toolkit 설치

```bash
# NVIDIA Container Toolkit 저장소 추가
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
  sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo

# 설치
sudo dnf install -y nvidia-container-toolkit

# containerd에 nvidia 런타임 추가
sudo nvidia-ctk runtime configure --runtime=containerd
```

### k3s containerd 템플릿 설정

k3s는 자체 containerd 설정을 사용하므로 **템플릿 파일**을 수정해야 합니다:

```bash
sudo tee /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl << 'EOF'
{{ template "base" . }}

[plugins.'io.containerd.cri.v1.runtime'.containerd]
  default_runtime_name = "nvidia"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.nvidia]
  runtime_type = "io.containerd.runc.v2"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.nvidia.options]
  BinaryName = "/usr/bin/nvidia-container-runtime"
  SystemdCgroup = true
EOF

# k3s 재시작
sudo systemctl restart k3s
```

### NVIDIA Device Plugin 설치

Kubernetes에서 GPU 리소스를 관리하고 스케줄링하기 위해서는 NVIDIA Device Plugin이 필요합니다. Helm Chart로 Device Plugin을 설치하거나 gpu-operator를 선택해도 되지만, 여기서는 간단한 환경 구성을 위해 공식 yaml 파일로만 구성합니다.

Device Plugin이 성공적으로 구성되기 위해서는 먼저 NVIDIA Driver와 위에서 설치한 NVIDIA Container Toolkit이 필요합니다.

Driver는 Kernel 모듈, CUDA 라이브러리를 제공하여 직접 GPU 하드웨어와 통신하고, Container Toolkit은 컨테이너 내부에서 GPU 접근이 가능하게 합니다.


```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.0/deployments/static/nvidia-device-plugin.yml
```

### GPU 연동 확인

성공적으로 구성이 되었다면, node에 nvidia.com/gpu가 표시되고, pod에서 nvidia-smi 명령어의 결과가 잘 출력됩니다.

```bash
# 클러스터 상태 확인
kubectl get nodes -o wide

# GPU 리소스 확인 (nvidia.com/gpu: 1 표시)
kubectl describe node | grep -A 10 "Capacity:"

# GPU 테스트 Pod 실행
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test
spec:
  restartPolicy: Never
  containers:
  - name: gpu-test
    image: nvidia/cuda:12.8.0-base-ubi9
    command: ["nvidia-smi"]
    resources:
      limits:
        nvidia.com/gpu: 1
EOF

# 결과 확인
kubectl logs gpu-test
```

## vLLM 배포

### 네임스페이스 및 PVC 생성

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: vllm
---
# pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vllm-model-cache
  namespace: vllm
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
```

모델 캐시용 PVC를 사용하면 Pod 재시작 시 모델을 다시 다운로드할 필요가 없습니다.

### Deployment 작성

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-mistral
  namespace: vllm
spec:
  strategy:
    type: Recreate  # 단일 GPU 환경에서 필수, default는 Rolling
  replicas: 1
  selector:
    matchLabels:
      app: vllm-mistral
  template:
    metadata:
      labels:
        app: vllm-mistral
    spec:
      containers:
      - name: vllm
        image: vllm/vllm-openai:latest
        args:
        - "--model"
        - "TheBloke/Mistral-7B-Instruct-v0.2-AWQ"
        - "--quantization"
        - "awq"
        - "--gpu-memory-utilization"
        - "0.90"
        - "--max-model-len"
        - "8192"
        - "--enforce-eager"
        resources:
          limits:
            nvidia.com/gpu: 1
        ports:
        - containerPort: 8000
        volumeMounts:
        - name: model-cache
          mountPath: /root/.cache/huggingface
        - name: shm
          mountPath: /dev/shm
      volumes:
      - name: model-cache
        persistentVolumeClaim:
          claimName: vllm-model-cache
      - name: shm
        emptyDir:
          medium: Memory
          sizeLimit: 4Gi
```

### 주요 vllm 파라미터 및 설정 설명

| 설정 | 값 | 이유 |
|------|-----|------|
| `strategy: Recreate` | - | 단일 GPU에서 RollingUpdate는 새 Pod가 GPU를 얻지 못함 |
| `--gpu-memory-utilization` | 0.90 | VRAM 90%까지 사용 (나머지는 시스템 예약) |
| `--max-model-len` | 8192 | 모델이 한번에 처리할 수 있는 최대 컨텍스트 길이 (input + output tokens) |
| `--enforce-eager` | - | torch.compile 비활성화 (WSL 호환성) |
| `/dev/shm` | 4Gi | PyTorch 멀티프로세싱용 공유 메모리 |
| `quantization` | awq | 여기서는 4-bit 양자화 (awq, gptq, fp8) |
| `--dtype` | auto (default) | 모델 정밀도 (auto, bfloat16, float16, float32) |
| `--tensor-parallel-size` | 1 (default) | 다중 GPU 사용 시 모델 분산, TP=2면 GPU 2개에 모델 분할, GPU 통신의 오버헤드는 있으나 요청량이 커질수록 처리량 증가 |
| `--max-num-seqs` | 256 (default) | GPU 메모리에 동시에 로드 가능한 요청 수 |
| `--max-num-batched-tokens` | max-model-len (default) | 한 iteration에서 처리할 최대 토큰 수 (모든 시퀀스의 토큰 합) |

### Service 작성

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: vllm-mistral
  namespace: vllm
spec:
  selector:
    app: vllm-mistral
  ports:
  - port: 8000
    targetPort: 8000
  type: ClusterIP
```

### 배포 및 확인

```bash
# 배포
kubectl apply -f namespace.yaml
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml

# Pod 상태 확인
kubectl get pods -n vllm -w

# 로그 확인
kubectl logs -f -n vllm deployment/vllm-mistral

# API 테스트 (port-forward)
kubectl port-forward -n vllm svc/vllm-mistral 8000:8000 &
curl http://localhost:8000/v1/models
```

### 파라미터 간 상호작용 및 성능 트레이드오프

위의 vllm 파라미터 중에서 `max-model-len`, `max-num-seqs`, `max-num-batched-tokens` 세 파라미터는 GPU 메모리를 두고 긴밀하게 연결되어 있습니다. KV Cache 메모리는 대략 `max-model-len × max-num-seqs × layer_size`에 비례하므로, `max-model-len`을 크게 설정하면 긴 문서를 처리할 수 있지만 동시에 처리 가능한 요청 수(`max-num-seqs`)는 줄어듭니다. 반대로 `max-model-len`을 작게 하면 더 많은 요청을 동시에 처리할 수 있어 처리량(throughput)은 증가하지만 긴 컨텍스트는 처리할 수 없게 됩니다.

성능 최적화 관점에서 보면, **높은 처리량(throughput)**이 필요한 경우 - 예를 들어 많은 사용자의 짧은 질문을 처리하는 챗봇 서비스라면 `max-model-len=4096`, `max-num-seqs=512`, `max-num-batched-tokens=16384`처럼 설정하여 동시에 많은 요청을 처리하도록 합니다. 이 경우 GPU 활용도가 높아져 초당 처리 요청 수가 최대화되지만, 대기열에서 기다리는 시간이 길어질 수 있습니다.

반면 **낮은 지연시간(latency)**이 중요한 경우 - 실시간 대화나 코딩 어시스턴트처럼 빠른 응답이 필요하다면 `max-model-len=2048`, `max-num-seqs=16`, `max-num-batched-tokens=2048`로 작게 설정합니다. 이렇게 하면 각 요청이 빠르게 처리되어 첫 토큰까지의 시간(TTFT)과 전체 응답 시간이 짧아지지만, 전체 처리량은 감소하고 GPU 활용도가 낮아집니다.

문서 요약이나 RAG 서비스처럼 긴 컨텍스트가 필수인 경우에는 `max-model-len=16384`, `max-num-seqs=64`처럼 설정하되, 메모리 부족을 방지하기 위해 `gpu-memory-utilization=0.95`로 메모리를 최대한 활용해야 합니다. 메모리가 부족하면 vLLM이 자동으로 `max-num-seqs`를 줄이므로, 실제 동시 처리 가능한 요청 수는 설정값보다 적을 수 있습니다.

일반적인 프로덕션 환경에서는 `max-model-len=8192`, `max-num-seqs=128`, `max-num-batched-tokens=8192` 정도가 균형 잡힌 설정이며, 처음에는 보수적으로 설정한 후 vLLM의 로그와 `/metrics` 엔드포인트를 통해 실제 메모리 사용량과 처리 성능을 모니터링하면서 점진적으로 조정하는 것이 좋습니다.


## 트러블슈팅

### torch.compile 에러

```
subprocess.CalledProcessError: Command '['which', 'c++']' returned non-zero
```

**해결:** `--enforce-eager` 플래그 추가

### 재배포 시 Pending 상태

단일 GPU 환경에서 기본 RollingUpdate 전략 사용 시 발생합니다.

**해결:** `strategy: type: Recreate` 설정

### /dev/shm 부족

```
RuntimeError: unable to mmap ... No space left on device
```

**해결:** shm 볼륨 크기 증가 (기본 64MB → 4Gi)

## 모니터링 구성

### vLLM 메트릭

vLLM은 `/metrics` 엔드포인트로 Prometheus 메트릭을 제공합니다:

| 메트릭 | 설명 |
|--------|------|
| `vllm:num_requests_running` | 현재 처리 중인 요청 수 |
| `vllm:num_requests_waiting` | 대기 중인 요청 수 |
| `vllm:gpu_cache_usage_perc` | KV Cache 사용률 |
| `vllm:avg_generation_throughput_toks_per_s` | 평균 생성 처리량 |

### Prometheus 설정

```yaml
# prometheus-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
    scrape_configs:
      - job_name: 'vllm'
        static_configs:
          - targets: ['vllm-mistral.vllm.svc:8000']
      - job_name: 'dcgm'
        static_configs:
          - targets: ['dcgm-exporter.monitoring.svc:9400']
```

### GPU 메트릭 (DCGM Exporter)

```yaml
# dcgm-exporter.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: dcgm-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: dcgm-exporter
  template:
    metadata:
      labels:
        app: dcgm-exporter
    spec:
      containers:
      - name: dcgm-exporter
        image: nvcr.io/nvidia/k8s/dcgm-exporter:3.3.5-3.4.0-ubuntu22.04
        ports:
        - containerPort: 9400
        securityContext:
          privileged: true
        volumeMounts:
        - name: device-plugin
          mountPath: /var/lib/kubelet/device-plugins
      volumes:
      - name: device-plugin
        hostPath:
          path: /var/lib/kubelet/device-plugins
```

주요 DCGM 메트릭

| 메트릭 | 설명 |
|--------|------|
| `DCGM_FI_DEV_GPU_UTIL` | GPU 사용률 (%) |
| `DCGM_FI_DEV_FB_USED` | GPU 메모리 사용량 (MB) |
| `DCGM_FI_DEV_GPU_TEMP` | GPU 온도 (°C) |
| `DCGM_FI_DEV_POWER_USAGE` | 전력 사용량 (W) |

## API 사용 예시

### 모델 목록 확인

```bash
curl http://localhost:8000/v1/models
```

### Chat Completion

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "TheBloke/Mistral-7B-Instruct-v0.2-AWQ",
    "messages": [
      {"role": "user", "content": "Python으로 피보나치 수열을 구현해주세요."}
    ],
    "max_tokens": 200
  }'
```

### Python 클라이언트

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="TheBloke/Mistral-7B-Instruct-v0.2-AWQ",
    messages=[
        {"role": "user", "content": "마이크로서비스 아키텍처를 설명해주세요."}
    ],
    max_tokens=200
)

print(response.choices[0].message.content)
```

## 결론

k3s와 vLLM을 조합하면 가벼운 LLM 서빙 환경을 구축할 수 있습니다. 이 환경을 기반으로 부하 테스트, 성능 최적화, 오토스케일링 등을 추가로 구성할 수 있습니다. 유의미한 LLM 기능을 구현하기는 힘들지만, LLM의 동작이나 내부 원리를 살펴보기에는 충분히 의미가 있는 구성입니다. 다음에는 해당 환경에서 실제 LLM이 어떻게 동작하는지, 또 어떤 방식으로 throughput, latency 등을 최적화할 수 있는지를 알아보겠습니다.

## Reference

- [vLLM Documentation](https://docs.vllm.ai/en/latest/)
- [k3s Documentation](https://docs.k3s.io/)
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
- [NVIDIA k8s-device-plugin](https://github.com/NVIDIA/k8s-device-plugin)
- [DCGM Exporter](https://github.com/NVIDIA/dcgm-exporter)
