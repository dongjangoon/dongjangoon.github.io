---
layout: post
title: "Kubernetes Logging Architecture"
date: 2025-04-09 10:45:00 +0000
categories: [kubernetes]
tags: [kubernetes, k8s, logging, architecture, tech]
excerpt: "로그 파일은 기본적으로 하나하나는 용량이 작을 수 있지만, 쌓이다 보면 그것이 커져 시스템 성능에 영향을 줄 수 있다."
notion_id: 1d0eef64-a1ca-80fa-8fd3-e1bd3f272965
notion_url: https://www.notion.so/Kubernetes-Logging-Architecture-1d0eef64a1ca80fa8fd3e1bd3f272965
---

# Kubernetes Logging Architecture

쿠버네티스는 로그를 어떻게 관리할까.

<!--more-->

로그 파일은 기본적으로 하나하나는 용량이 작을 수 있지만, 쌓이다 보면 그것이 커져 시스템 성능에 영향을 줄 수 있다.

이를 잘 관리하는 것 역시 중요한데, 쿠버네티스는 어떤 식으로 로그를 관리하는지 간략하게 살펴보자.
우선 쿠버네티스의 로깅 아키텍처는 크게 두 가지 수준으로 구분할 수 있다.

## 1. Node-level logging

쿠버네티스는 기본적으로 컨테이너의 `stdout/stderr` 로그를 노드의 로컬 파일 시스템에 저장한다. 정확히는 노드의 `/var/log/containers` 경로에 `{쿠버네티스 리소스 + 네임스페이스 + 컨테이너 이름과 해시값의 조합}.log` 파일로 로그를 떨군다. 이 폴더는 `/var/log/pods` 와 심볼릭 링크가 걸려 있어 해당 경로에도 같은 로그 파일이 존재한다. 

구체적으로 로그 파일을 저장하는 원리는 다음과 같다. `containerd`와 같은 CRI가 `stdout/stderr`로 출력하는 로그를 `kubelet`이 가로채어 해당 경로에 저장하는 로직을 수행한다.

### 만약  /var/log 경로에 로그가 무한정 쌓인다면?

당연히 노드에 disk pressure가 발생하고 이는 해당 노드가 재기 불능 상태까지 가는 심각한 장애를 초래할 수 있다. 

당연히 Kubernetes에는 이를 대비하기 위한 방법이 있고, 바로 로그 로테이션이다. 이 로그 로테이션 정책은 파일 크기(기본 10MB) 기준으로 이루어지며, 특정 수의 로그 파일까지는 5개만 유지한다.

아래와 같은 방식으로 정책이 적용되어 있고, 실제 해당 위치에서 확인할 수 있다.

```
# /etc/logrotate.d/kubernetes 파일

/var/log/pods/*/*.log {
    daily
    missingok
    rotate 5
    compress
    notifempty
    create 644 root root
}

/var/log/containers/*.log {
    daily
    missingok  
    rotate 5
    compress
    notifempty
    create 644 root root
}
```

또한 `kubelet` 설정에서도 로그의 최대 크기와 개수를 설정할 수 있다.

```yaml
# kubelet 설정
containerLogMaxSize: 100Mi
containerLogMaxFiles: 5
```

### LogRotate와의 관계

- LogRotate는 리눅스 시스템에서 사용되는 로그 로테이션 도구이다.
- `/var/lib/logrotate`에서 어떤 프로그램들이 LogRotate를 통해 관리되는지 확인할 수 있다.
- 쿠버네티스 자체는 LogRotate를 사용하지 않고, kubelet과 컨테이너 런타임의 내장 로그 로테이션 메커니즘을 사용한다. (`/var/lib/kubelet/config.yaml`)
- 하지만 노드 자체의 시스템 로그(kubelet, kube-proxy 등)는 LogRotate 설정을 통해 관리할 수 있다.
- LogRotate의 설정은 `/etc/logrotate.conf`, `/etc/logrotate.d`에 설정되어 있다.
- 스케줄러, 컨트롤러 매니저, API 서버, etcd, kube-proxy는 보통 쿠버네티스 컨트롤 플레인으로 설치되지만 kubelet은 systemd 같은 시스템 프로세스로 설치된다.

## 2. cluster-level logging

Node-level Logging에서 컨테이너가 크래시되거나, 파드가 축출되거나, 노드가 종료될 경우에 애플리케이션의 로그에 접근하고 싶을 때, 해당 로그는 해당 리소스의 안에 존재한다.

즉, 해당 로그에 접근할 수가 없다.

따라서 클러스터에서 애플리케이션, 즉 노드, 컨테이너 그리고 파드와 같은 리소스의 로그는 해당 리소스와는 별도의 스토리지와 라이프사이클로 관리되어야 한다. 이를 cluster-level logging 이라고 한다.

CLI 아키텍처는 로그를 저장, 분석, 조회할 별도의 백엔드를 필요로 하지만, 쿠버네티스 자체에서는 그런 솔루션을 제공하지 않는다.

다신 사용할 수 있는 몇 가지 일반적인 방법들이 존재한다.

### 1. 노드 로깅 에이전트 사용

- 로깅 에이전트 파드를 설정하여 로그에 접근
- 모든 노드에서 설정되므로 DaemonSet이 적합

### 2. 로깅 에이전트와 사이드카 컨테이너 사용

- 사이드카 컨테이너가 애플리케이션 로그를 자체 stdout으로 스트리밍
- 동시에 로깅 에이전트를 설정하며, 애플리케이션에서 로그를 가져옴
- 사이드카에 로깅 에이전트가 있는 게 아니라 로깅 에이전트 파드가 따로 필요함

### 3. 로깅 에이전트가 있는 사이드카 컨테이너

- fluentd와 같이 애플리케이션 컨테이너 내의 모든 소스에서 로그를 읽어들 수 있는 로깅 에이전트 사이드카