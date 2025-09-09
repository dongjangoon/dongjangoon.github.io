---
layout: post
title: "Nginx와 epoll: 고성능 웹서버의 핵심 기술"
date: 2025-09-07 12:00:00 +0000
categories: [Linux]
tags: [nginx, epoll, non-blocking-io, event-driven, web-server, performance]
excerpt: "Nginx가 어떻게 epoll을 활용해 높은 성능과 확장성을 달성하는지, 이벤트 기반 비동기 아키텍처의 핵심 원리를 살펴봅니다."
---

## 들어가며

Nginx는 현재 세계에서 가장 많이 사용되는 웹서버 중 하나입니다. Apache HTTP Server와 달리 Nginx는 **이벤트 기반 비동기 아키텍처**를 채택하여 적은 메모리로 높은 동시성을 처리할 수 있습니다.

이 글에서는 Nginx의 핵심 기술인 **epoll**과 **Non-blocking I/O**를 중심으로 고성능 웹서버의 동작 원리를 깊이 있게 분석해보겠습니다.

## Nginx 아키텍처 개요

### 핵심 특징

- **이벤트 기반 비동기 아키텍처**: 요청을 이벤트로 처리
- **Non-blocking I/O**: I/O 작업 시 프로세스가 차단되지 않음  
- **높은 성능과 확장성**: 적은 리소스로 많은 동시 연결 처리

### Nginx의 프로세스 모델

#### 1. 마스터-워커 프로세스 구조

**마스터 프로세스 (Master Process)**:
- 설정 파일 읽기 및 검증
- 워커 프로세스 생성 및 관리
- 신호 처리 (reload, shutdown 등)

**워커 프로세스 (Worker Process)**:
- 실제 클라이언트 요청 처리
- 일반적으로 CPU 코어 수만큼 생성
- 각 워커는 독립적으로 동작하며 프로세스 간 공유 상태 없음

#### 2. 이벤트 루프

각 워커 프로세스는 **단일 스레드**에서 **이벤트 루프**를 실행합니다:

```
while (true) {
    // 1. epoll_wait()로 이벤트 대기
    events = epoll_wait(epfd, events, maxevents, timeout);
    
    // 2. 발생한 이벤트 순차 처리
    for (event in events) {
        handle_event(event);
    }
    
    // 3. 타이머 처리, 정리 작업 등
    process_timers();
}
```

#### 3. Non-blocking I/O

Nginx는 모든 I/O 작업을 **논블로킹**으로 처리합니다:

- **클라이언트 연결 수락**: `accept()` 호출이 즉시 반환
- **데이터 읽기/쓰기**: `read()`, `write()` 호출이 즉시 반환
- **파일 I/O**: 디스크 읽기/쓰기도 논블로킹으로 처리

### 이벤트 처리 흐름

1. **클라이언트 연결**: 새로운 TCP 연결이 들어오면 `accept` 이벤트 발생
2. **요청 파싱**: HTTP 요청 헤더를 논블로킹으로 읽어서 파싱
3. **리소스 처리**: 정적 파일 서빙 또는 업스트림 서버로 프록시
4. **응답 전송**: 클라이언트에게 응답 데이터 전송
5. **연결 관리**: Keep-Alive 또는 연결 종료 처리

## epoll: Linux의 고성능 I/O 멀티플렉싱

### epoll이란?

**epoll**은 Linux 2.6부터 도입된 I/O 이벤트 알림 메커니즘으로, 이전 `select`/`poll`의 성능 문제를 **O(n)에서 O(1)로 개선**했습니다.

### 기존 방식의 한계

**select/poll의 문제점:**
- **O(n) 복잡도**: 모든 파일 디스크립터를 순차적으로 검사
- **파일 디스크립터 수 제한**: select는 FD_SETSIZE(보통 1024)로 제한
- **커널-유저 공간 데이터 복사**: 매번 전체 fd set을 복사

**epoll의 해결책:**
- **O(1) 복잡도**: 이벤트가 발생한 fd만 반환
- **확장성**: 수십만 개의 동시 연결 처리 가능
- **효율적인 메모리 사용**: 이벤트 발생 시에만 데이터 전달

### epoll 시스템 콜

#### 1. epoll_create()
```c
int epfd = epoll_create1(EPOLL_CLOEXEC);
```
- **epoll 인스턴스 생성**
- 커널에서 epoll을 위한 자료구조 초기화
- 파일 디스크립터 반환

#### 2. epoll_ctl()
```c
struct epoll_event event;
event.events = EPOLLIN | EPOLLET;  // Edge-triggered 모드
event.data.fd = sockfd;

epoll_ctl(epfd, EPOLL_CTL_ADD, sockfd, &event);
```
- **모니터링할 소켓(fd)을 등록/수정/삭제**
- `EPOLL_CTL_ADD`: 새로운 fd 등록
- `EPOLL_CTL_MOD`: 기존 fd의 이벤트 마스크 수정
- `EPOLL_CTL_DEL`: fd 제거

#### 3. epoll_wait()
```c
int nfds = epoll_wait(epfd, events, MAX_EVENTS, timeout);

for (int i = 0; i < nfds; i++) {
    if (events[i].events & EPOLLIN) {
        // 읽기 가능한 데이터 있음
        handle_read(events[i].data.fd);
    }
    if (events[i].events & EPOLLOUT) {
        // 쓰기 가능함
        handle_write(events[i].data.fd);
    }
}
```
- **이벤트가 발생할 때까지 대기**
- 이벤트 발생 시 해당 fd들의 배열 반환
- 타임아웃 설정 가능

### epoll 동작 과정 예시

고성능 웹서버에서 HTTP 요청을 처리하는 과정을 살펴보겠습니다:

#### 1단계: 클라이언트 연결 수락
```
1. 클라이언트가 TCP 연결 요청
2. 서버 소켓에 EPOLLIN 이벤트 발생
3. epoll_wait()에서 서버 소켓 반환
4. accept()로 새로운 클라이언트 소켓 생성 (소켓 A)
5. 소켓 A를 epoll에 등록 (EPOLLIN 이벤트 모니터링)
```

#### 2단계: HTTP 요청 수신
```
6. 클라이언트가 HTTP 요청 전송
7. 커널이 네트워크 데이터 수신
8. 소켓 A에 EPOLLIN 이벤트 발생
9. 커널이 소켓 A를 ready list에 추가
10. epoll_wait() 호출 시 소켓 A 반환
```

#### 3단계: 비동기 파일 처리
```
11. 소켓 A에서 HTTP 요청 읽기 (GET /index.html)
12. 요청된 파일을 디스크에서 읽기 시작 (논블로킹 방식)
13. 파일 I/O를 위한 별도 fd(B) 생성하여 epoll에 등록
14. 다른 소켓 이벤트 처리로 전환 (블로킹되지 않음)
```

#### 4단계: 응답 전송
```
15. 파일 읽기 완료 → fd B에 EPOLLIN 이벤트 발생
16. 커널이 fd B를 ready list에 추가
17. 다음 epoll_wait() 호출 시 fd B 반환
18. 파일 데이터를 소켓 A를 통해 클라이언트에 전송
19. 전송 완료 후 연결 정리 또는 Keep-Alive 처리
```

### Edge-Triggered vs Level-Triggered

#### Level-Triggered (LT) 모드
- **상태 기반**: 데이터가 있는 동안 계속 이벤트 발생
- **안전함**: 이벤트를 놓쳐도 다음 epoll_wait()에서 다시 알림
- **상대적으로 많은 시스템 콜**: 같은 fd에 대해 반복적으로 이벤트 발생

#### Edge-Triggered (ET) 모드
- **변화 기반**: 상태가 변할 때만 이벤트 발생
- **높은 성능**: 불필요한 시스템 콜 감소
- **복잡한 구현**: 이벤트를 놓치지 않도록 주의 필요

**Nginx는 ET 모드를 사용**하여 최고의 성능을 달성합니다.

## 왜 멀티스레딩이 아닌 멀티프로세싱인가?

Nginx가 멀티스레딩 대신 멀티프로세싱을 선택한 이유:

### 1. 컨텍스트 스위칭 오버헤드 최소화
- **프로세스**: CPU 코어별로 하나씩 배치하여 컨텍스트 스위칭 최소화
- **스레드**: 빈번한 스레드 전환으로 인한 성능 저하

### 2. 공유 메모리 경합 방지
- **프로세스**: 각 워커가 독립적인 메모리 공간 사용
- **스레드**: 공유 메모리로 인한 락(lock) 경합과 동기화 오버헤드

### 3. IPC(Inter-Process Communication) 최소화
- 각 워커 프로세스가 독립적으로 동작하여 프로세스 간 통신 거의 불필요
- 설정 변경이나 통계 정보 공유 시에만 제한적으로 IPC 사용

### 4. 안정성
- 하나의 워커 프로세스가 크래시해도 다른 워커들은 정상 동작
- 마스터 프로세스가 죽은 워커를 자동으로 재시작

## Nginx의 추가 최적화 기술

### 1. MIME 타입 관리

**타입 해시 테이블 (types hash table)**:
- Nginx에서 MIME 타입 매핑을 저장하고 빠르게 조회하기 위해 사용하는 내부 자료구조
- 파일 확장자와 MIME 타입 간의 매핑을 빠르게 찾기 위해 사용
- `.html` 파일을 받았을 때 바로 `text/html` MIME 타입을 즉시 결정

**MIME 타입 스니핑 방지**:
- 웹 브라우저가 서버로부터 받은 콘텐츠의 MIME 타입을 추측하는 과정 방지
- 서버가 정확한 Content-Type 헤더를 전송하여 보안 위험 최소화

### 2. 연결 관리 최적화

**Keep-Alive 설정**:
```nginx
http {
    keepalive_timeout 65;
    keepalive_requests 1000;
}
```

**클라이언트와 백엔드의 Keep-Alive 시간 분리**:
- **클라이언트 연결**: 브라우저의 빠른 리소스 로딩을 위해 적절한 시간 설정
- **백엔드 연결**: 다른 클라이언트 요청을 처리할 때 연결 재사용을 위해 더 긴 시간 설정

### 3. 업스트림 커넥션 풀

```nginx
upstream backend {
    server backend1.example.com;
    server backend2.example.com;
    keepalive 32;  # 백엔드와의 연결 풀 크기
}
```

백엔드 서버와의 연결을 효율적으로 재사용하여 성능 향상을 달성합니다.

## 성능 벤치마크

### Apache vs Nginx 비교

**동시 연결 수**:
- **Apache (prefork)**: ~4,000 동시 연결 (메모리 부족으로 제한)
- **Nginx**: ~10,000+ 동시 연결 (C10K 문제 해결)

**메모리 사용량**:
- **Apache**: 연결당 ~8MB (프로세스/스레드 기반)
- **Nginx**: 연결당 ~2.5KB (이벤트 기반)

**CPU 효율성**:
- **Nginx**: 적은 CPU 사용률로 더 많은 요청 처리
- 특히 정적 파일 서빙에서 압도적 성능 우위

## 실제 운영 시 고려사항

### 1. 워커 프로세스 수 설정
```nginx
worker_processes auto;  # CPU 코어 수에 맞춰 자동 설정
worker_connections 1024;  # 워커당 최대 연결 수
```

### 2. 파일 디스크립터 한계
```bash
# 시스템 레벨 설정
echo "fs.file-max = 2097152" >> /etc/sysctl.conf

# 프로세스별 제한
ulimit -n 65536
```

### 3. 캐싱 최적화
```nginx
location ~* \.(jpg|jpeg|png|css|js)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## 결론

Nginx의 뛰어난 성능은 **epoll 기반의 이벤트 드리븐 아키텍처**와 **Non-blocking I/O**의 조합으로부터 나옵니다:

### 핵심 성공 요인

1. **이벤트 기반 처리**: 전통적인 스레드 기반 모델의 한계 극복
2. **epoll 활용**: Linux 커널의 고성능 I/O 멀티플렉싱 기술 활용
3. **논블로킹 I/O**: 모든 I/O 작업에서 블로킹 최소화
4. **멀티프로세스 모델**: 안정성과 성능의 최적 균형점

### 현대적 의의

Nginx의 아키텍처는 현재 많은 고성능 시스템에서 채택하고 있는 패턴이 되었습니다:
- **Node.js**: 단일 스레드 이벤트 루프
- **Redis**: 단일 스레드 + epoll
- **Go**: 고루틴 기반 비동기 I/O

웹서버의 성능 요구사항이 계속 증가하는 현재, Nginx와 epoll의 조합은 여전히 가장 효과적인 해결책 중 하나입니다.