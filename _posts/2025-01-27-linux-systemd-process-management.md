---
layout: single
title: "Linux Systemd: 프로세스 관리의 핵심을 이해하자"
date: 2025-01-27 10:00:00 +0900
categories: linux
tags: [linux, systemd, process, init, daemon, cgroups, service-management]
excerpt: "터미널에서 실행한 프로세스와 systemd로 등록한 서비스는 어떻게 다를까? Linux의 심장인 systemd와 프로세스 관리의 핵심 개념들을 살펴봅니다."
---

## 들어가며

서버에서 애플리케이션을 실행할 때, 단순히 `./app` 명령어로 실행하는 것과 systemd 서비스로 등록하는 것은 어떤 차이가 있을까요?

SSH로 서버에 접속해서 프로그램을 실행했는데, 로그아웃하니 프로세스가 종료된 경험이 있으신가요? 또는 서버가 재부팅되었는데 애플리케이션이 자동으로 시작되지 않아 당황한 적은요?

이 글에서는 Linux 시스템의 핵심인 **systemd**가 무엇인지, 일반 프로세스와 systemd 서비스의 차이는 무엇인지, 그리고 이 과정에서 등장하는 여러 CS 개념들을 함께 살펴보겠습니다.

## 일반 프로세스 vs Systemd 서비스

### 터미널에서 직접 실행한 프로세스

터미널에서 프로그램을 실행하면 어떤 일이 일어날까요?

```bash
# 터미널에서 직접 실행
python app.py
```

이렇게 실행된 프로세스는 다음과 같은 특징을 가집니다.

1. **터미널 세션에 종속**: 프로세스의 부모는 현재 쉘(bash, zsh 등)이 됩니다
2. **로그아웃 시 종료**: SSH 세션이 끊기면 SIGHUP 시그널을 받아 종료됩니다
3. **수동 관리 필요**: 재시작, 상태 확인 등을 직접 해야 합니다

### 프로세스 계층 구조

Linux에서 모든 프로세스는 부모-자식 관계로 연결된 트리 구조를 이룹니다:

```
systemd (PID 1)
├── sshd
│   └── bash (SSH 세션)
│       └── python app.py  ← 여기에 위치
├── kubelet
├── containerd
└── ...
```

터미널에서 실행한 프로세스는 쉘의 자식 프로세스가 되므로, 쉘이 종료되면 함께 종료됩니다. 이것이 **프로세스 그룹**과 **세션** 개념입니다.

### nohup과 &의 한계

많은 분들이 이 문제를 해결하기 위해 `nohup`과 `&`를 사용합니다:

```bash
nohup python app.py &
```

- `nohup`: SIGHUP 시그널을 무시하도록 설정
- `&`: 백그라운드에서 실행

하지만 이 방법에는 여전히 한계가 있습니다.

| 항목 | nohup 방식 | Systemd 서비스 |
|------|-----------|---------------|
| 자동 시작 | 불가능 (수동 실행 필요) | 부팅 시 자동 시작 |
| 크래시 복구 | 수동으로 재시작 | 자동 재시작 가능 |
| 로그 관리 | nohup.out에 쌓임 | journald로 통합 관리 |
| 상태 확인 | ps, pgrep으로 직접 확인 | systemctl status로 확인 |
| 의존성 관리 | 직접 순서 조절 | 선언적으로 정의 |
| 리소스 제한 | ulimit 수동 설정 | cgroups로 세밀하게 제어 |

## Systemd란 무엇인가?

### Init 시스템의 역할

컴퓨터가 부팅되면 커널이 가장 먼저 실행하는 프로세스가 있습니다. 이것이 바로 **init 시스템**이며, 항상 **PID 1**을 부여받습니다.

```bash
$ ps -p 1
  PID TTY          TIME CMD
    1 ?        00:01:23 systemd
```

PID 1인 프로세스는 특별한 책임을 가집니다.

1. **모든 프로세스의 조상**: 다른 모든 프로세스의 시작점
2. **고아 프로세스 입양**: 부모가 먼저 종료된 프로세스를 거둬들임
3. **시스템 초기화**: 파일시스템 마운트, 네트워크 설정, 서비스 기동

### Init 시스템의 역사

Linux init 시스템은 크게 세 세대로 나눌 수 있습니다.

**1세대: SysVinit (1983~)**
```bash
# 쉘 스크립트 기반
/etc/init.d/nginx start
/etc/init.d/nginx stop
```
- 순차적 실행으로 부팅 속도 느림
- 스크립트 직접 작성 필요
- 의존성 관리 어려움

**2세대: Upstart (2006~)**
- Ubuntu에서 시작
- 이벤트 기반 구조 도입
- 병렬 실행 지원

**3세대: Systemd (2010~)**
- 병렬 실행으로 빠른 부팅
- 선언적 설정 파일
- 통합된 로깅, 네트워크, 시간 동기화

현재 대부분의 주요 배포판(RHEL, Ubuntu, Debian, Fedora 등)이 systemd를 표준으로 채택하고 있습니다.

### Systemd 구성 요소

Systemd는 단순한 init 시스템이 아니라 여러 데몬의 집합입니다:

| 컴포넌트 | 역할 |
|---------|-----|
| **systemd** | 서비스 관리 (PID 1) |
| **journald** | 중앙 집중식 로그 수집 |
| **networkd** | 네트워크 설정 관리 |
| **resolved** | DNS 리졸버 |
| **timesyncd** | NTP 시간 동기화 |
| **logind** | 사용자 세션 관리 |

## Unit 파일 이해하기

### Unit의 개념

Systemd는 관리 대상을 **Unit** 이라는 단위로 추상화합니다.

| Unit 타입 | 확장자 | 용도 |
|----------|--------|-----|
| Service | .service | 데몬, 애플리케이션 |
| Socket | .socket | 소켓 기반 활성화 |
| Timer | .timer | 스케줄링 (cron 대체) |
| Mount | .mount | 파일시스템 마운트 |
| Target | .target | Unit 그룹화 |

### Service Unit 구조

Service unit 파일은 세 개의 섹션으로 구성됩니다.

```ini
[Unit]
# 메타데이터와 의존성 정의
Description=My Application Server
Documentation=https://example.com/docs
After=network.target postgresql.service
Requires=postgresql.service

[Service]
# 프로세스 실행 방법 정의
Type=simple
User=appuser
Group=appgroup
WorkingDirectory=/opt/myapp
ExecStart=/opt/myapp/bin/server
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

[Install]
# 활성화 시 동작 정의
WantedBy=multi-user.target
```

### [Unit] 섹션 상세

**의존성 관리 디렉티브:**

```ini
# 순서만 지정 (해당 Unit 이후에 시작)
After=network.target

# 의존성 + 순서 (필수, 실패 시 함께 실패)
Requires=postgresql.service

# 약한 의존성 (있으면 좋고, 없어도 됨)
Wants=redis.service
```

`After`와 `Requires`의 차이를 이해하는 것이 중요합니다.

- `After=A`: A가 시작된 후에 시작 (순서만)
- `Requires=A`: A가 없으면 시작 실패 (의존성)
- 보통 둘을 함께 사용: `After=A` + `Requires=A`

### [Service] 섹션 상세

**Type 옵션:**

```ini
# simple (기본값): ExecStart가 메인 프로세스
Type=simple

# forking: 전통적인 데몬처럼 fork() 후 부모 종료
Type=forking
PIDFile=/var/run/myapp.pid

# oneshot: 실행 후 종료되는 작업
Type=oneshot

# notify: 준비 완료 시 systemd에 알림
Type=notify
```

**재시작 정책:**

```ini
# 재시작 조건
Restart=no              # 재시작 안함
Restart=on-failure      # 비정상 종료 시에만
Restart=always          # 항상 재시작
Restart=on-abnormal     # 시그널/타임아웃/watchdog

# 재시작 대기 시간
RestartSec=5
```

**환경 변수:**

```ini
# 직접 지정
Environment="NODE_ENV=production"
Environment="PORT=8080"

# 파일에서 읽기
EnvironmentFile=/etc/myapp/config.env

# 여러 파일 (없어도 에러 안남)
EnvironmentFile=-/etc/myapp/optional.env
```

## Cgroups: 리소스 제어의 핵심

### Cgroups란?

컨테이너의 개념을 설명할 때도 많이 등장하는 **Control Groups (cgroups)** 는 Linux 커널 기능으로, 프로세스 그룹의 리소스 사용량을 제한하고 모니터링합니다. Systemd는 각 서비스를 별도의 cgroup에서 실행합니다.

```bash
# 서비스의 cgroup 확인
$ systemctl status myapp
● myapp.service - My Application
     Loaded: loaded
     Active: active (running)
   Main PID: 1234 (myapp)
      Tasks: 4 (limit: 4915)
     Memory: 128.5M (limit: 512.0M)
        CPU: 1min 23s
     CGroup: /system.slice/myapp.service
             └─1234 /opt/myapp/bin/server
```

### 리소스 제한 설정

```ini
[Service]
# 메모리 제한
MemoryMax=512M
MemoryHigh=400M  # 소프트 제한 (초과 시 throttle)

# CPU 제한
CPUQuota=200%    # 2코어 분량
CPUWeight=100    # 상대적 가중치

# 파일 디스크립터 제한
LimitNOFILE=65535

# 프로세스 수 제한
LimitNPROC=4096

# I/O 제한
IOWeight=100
IOReadBandwidthMax=/dev/sda 100M
```

### Cgroups의 실제 활용

Kubernetes에서 Pod의 리소스 제한도 cgroups로 구현됩니다:

```yaml
# Kubernetes Pod spec
resources:
  limits:
    memory: "512Mi"
    cpu: "1000m"
```

이 설정은 결국 노드에서 다음과 같은 cgroup 제한으로 변환됩니다:

```bash
# /sys/fs/cgroup/memory/kubepods/pod-xxx/memory.limit_in_bytes
536870912  # 512Mi

# /sys/fs/cgroup/cpu/kubepods/pod-xxx/cpu.cfs_quota_us
100000  # 1 CPU
```

## Journald: 통합 로깅 시스템

### 기존 로깅의 문제점

전통적인 syslog 방식에는 한계가 있었습니다.

- 텍스트 기반으로 파싱 어려움
- 로그 손실 가능성
- 부팅 초기 로그 수집 어려움

### Journald의 특징

```bash
# 특정 서비스 로그 조회
journalctl -u myapp.service

# 실시간 로그 스트리밍
journalctl -u myapp.service -f

# 시간 범위 지정
journalctl -u myapp.service --since "2025-01-27 09:00" --until "2025-01-27 10:00"

# 부팅 이후 로그만
journalctl -u myapp.service -b

# JSON 형식 출력
journalctl -u myapp.service -o json-pretty
```

### 로그 메타데이터

Journald는 로그에 자동으로 메타데이터를 추가합니다.

```json
{
  "_PID": "1234",
  "_UID": "1000",
  "_GID": "1000",
  "_COMM": "myapp",
  "_EXE": "/opt/myapp/bin/server",
  "_SYSTEMD_UNIT": "myapp.service",
  "_HOSTNAME": "server01",
  "MESSAGE": "Application started on port 8080"
}
```

## 보안 강화 옵션

Systemd는 서비스 격리를 위한 다양한 보안 옵션을 제공합니다.

```ini
[Service]
# 권한 상승 방지
NoNewPrivileges=true

# 파일시스템 보호
ProtectSystem=strict    # /usr, /boot, /etc 읽기 전용
ProtectHome=true        # /home, /root, /run/user 접근 불가
PrivateTmp=true         # 별도의 /tmp 사용

# 네트워크 격리
PrivateNetwork=true     # 네트워크 네임스페이스 격리

# 장치 접근 제한
PrivateDevices=true     # /dev 장치 접근 제한

# 커널 설정 변경 방지
ProtectKernelTunables=true
ProtectKernelModules=true

# 특정 경로만 쓰기 허용
ReadWritePaths=/var/lib/myapp
ReadOnlyPaths=/etc/myapp
```

## Systemd와 Kubernetes의 관계

Kubernetes 노드에서 systemd는 핵심적인 역할을 합니다.

```
systemd (PID 1)
├── kubelet.service      ← Node의 에이전트
├── containerd.service   ← 컨테이너 런타임
└── ...
```

### Kubelet도 Systemd 서비스

```bash
# kubelet 상태 확인
systemctl status kubelet

# kubelet 로그 확인
journalctl -u kubelet -f
```

Kubernetes에서 노드 문제가 발생했을 때 가장 먼저 확인하는 것이 kubelet 서비스 상태입니다.

```bash
# 노드가 NotReady 상태일 때
journalctl -u kubelet --since "10 minutes ago" | grep -i error
```

## 결론

Systemd는 단순한 서비스 관리 도구를 넘어 Linux 시스템의 핵심 인프라입니다. 일반 프로세스와 systemd 서비스의 차이는 아래와 같습니다.

### 핵심 차이점 정리

| 관점 | 일반 프로세스 | Systemd 서비스 |
|-----|-------------|---------------|
| 생명주기 | 세션 종속 | 시스템 종속 |
| 부팅 시작 | 수동 | 자동 |
| 장애 복구 | 수동 | 자동 재시작 |
| 로깅 | 직접 관리 | journald 통합 |
| 리소스 제한 | ulimit | cgroups |
| 의존성 | 수동 순서 관리 | 선언적 정의 |

