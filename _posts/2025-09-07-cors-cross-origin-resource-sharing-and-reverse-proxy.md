---
layout: post
title: "CORS(Cross-Origin Resource Sharing)와 리버스 프록시: 웹 보안의 진화"
date: 2025-09-07 10:00:00 +0000
categories: [network, web]
tags: [cors, reverse-proxy, web-security, same-origin-policy, csrf, xss]
excerpt: "웹 애플리케이션 아키텍처가 MVC에서 CSR로 진화하면서 등장한 CORS 문제와 리버스 프록시를 통한 해결 방안을 살펴봅니다."
---

## 들어가며

현대 웹 애플리케이션 개발에서 프론트엔드와 백엔드를 분리하여 구성하는 것은 이제 일반적인 패턴이 되었습니다. 하지만 이러한 구조에서는 **CORS(Cross-Origin Resource Sharing)** 문제가 필연적으로 발생합니다. 

이 글에서는 왜 CORS가 등장하게 되었는지 역사적 배경을 살펴보고, 리버스 프록시를 통한 실용적 해결 방안을 제시합니다.

## CORS, 왜 생겨났을까?

### MVC 방식의 웹 애플리케이션

초기 웹 애플리케이션은 주로 **MVC(Model-View-Controller)** 패턴을 기반으로 구성되었습니다.

**작동 방식:**
1. **서버 측 렌더링(SSR)**: 백엔드 서버가 HTML을 직접 생성하여 클라이언트에게 전달 (JSP, Thymeleaf)
2. **동일 출처 요청**: 페이지 로드와 데이터 요청이 모두 같은 서버(도메인)에서 이루어짐
3. **폼 제출 방식**: 많은 상호작용이 전체 페이지 리로드를 통해 이루어짐

→ **JavaScript를 통한 API 호출이 아니라, 서버 측에서 데이터를 가져와 HTML에 통합하여 제공, AJAX 호출이 있더라도 대개 같은 도메인 내에서 이루어짐**

이 시대에는 CORS 문제가 거의 발생하지 않았습니다.

### CSR, CSRF, XSS의 등장

**AJAX의 등장**과 `XMLHttpRequest` 객체를 사용한 비동기 요청이 인기를 얻으면서(2006년 jQuery), 웹 애플리케이션의 패러다임이 변화했습니다. 하지만 동시에 이를 악용하는 보안 위협도 등장하기 시작했습니다.

#### CSRF(Cross-Site Request Forgery)

- 사용자가 인증된 상태에서 공격자의 사이트를 방문하면, 그 사이트에서 사용자 모르게 다른 사이트(ex. 은행)에 요청을 보내는 공격
- 세션, 쿠키 정보를 획득해서 악성 스크립트를 실행하도록 하면 의도하지 않은 행동이 수행됨 (패스워드 변경 등)
- **해결방법**: 해당 HTTP 요청이 사용자 인터페이스(UI)를 통해 이루어졌는지 확인하는 CSRF 토큰, Authentication 쿠키 외에 CSRF 토큰이 담긴 쿠키 확인

#### XSS(Cross-Site Scripting)

웹사이트에 악성 스크립트를 삽입하여 사용자의 브라우저에서 실행시키는 공격입니다.

## CORS(Cross-Origin Resource Sharing)

### CORS란?

- 브라우저가 자신의 출처가 아닌 다른 어떤 출처(도메인, 스킴, 포트)로부터 자원을 로딩하는 것을 허용하도록 서버가 허가해주는 **HTTP 헤더 기반 메커니즘**
- 보안상의 이유로 브라우저는 스크립트에서 시작한 교차 출처 HTTP 요청을 제한하고 있음
- JavaScript에서 사용되는 API 호출 함수인 `fetch`, `XMLHttpRequest`가 모두 **동일 출처 정책**을 따름

### CORS 작동 원리

- 서버에서 실제 요청을 허가할 것인지 브라우저가 보내는 **사전 요청(Preflight) 메커니즘**에 의존
- Preflight 시에는 브라우저가 실제 요청에서 사용할 HTTP 메서드와 헤더들에 대한 정보를 헤더에 담아서 보냄
- 백엔드 서버에서 따로 CORS 허용을 해줘야 할 필요가 있음

### 예시 상황

**시나리오:**
- 프론트엔드 도메인: `http://example.com`
- 백엔드 서버: `http://backend-server.com`

**문제점:**
- 리버스 프록시를 사용하지 않으면 백엔드에서 CORS 설정을 통해 프론트엔드 도메인에서 오는 요청을 허용해줄 필요가 있음

**해결방안:**
- 하지만 리버스 프록시를 사용하면 브라우저에서 페이지 로드와 API 요청 모두 같은 도메인에서 오는 것으로 인식하기 때문에 CORS 설정 없이도 백엔드와 프론트엔드 배포가 가능함

## 리버스 프록시 해결 방안

### 리버스 프록시란?

리버스 프록시는 클라이언트 요청을 받아 내부 서버로 전달하고, 응답을 다시 클라이언트에게 반환하는 중간 서버입니다.

### CORS 문제 해결 원리

**기존 구조 (CORS 발생):**
```
브라우저 (http://example.com) 
    ↓ CORS 에러 발생
백엔드 서버 (http://backend-server.com)
```

**리버스 프록시 구조 (CORS 해결):**
```
브라우저 (http://example.com)
    ↓ 동일 출처로 인식
리버스 프록시 (http://example.com)
    ↓ 내부 네트워크 통신
백엔드 서버 (http://backend-server.com)
```

### 리버스 프록시의 장점

1. **CORS 문제 근본 해결**: 브라우저가 모든 요청을 동일한 출처로 인식
2. **보안 강화**: 백엔드 서버를 외부에서 직접 접근할 수 없게 보호
3. **로드 밸런싱**: 여러 백엔드 서버로 요청을 분산
4. **SSL 종료**: HTTPS 처리를 프록시에서 담당
5. **정적 파일 서빙**: 프론트엔드 정적 파일을 효율적으로 제공

### Nginx를 통한 구현 예시

```nginx
server {
    listen 80;
    server_name example.com;
    
    # 프론트엔드 정적 파일 서빙
    location / {
        root /var/www/frontend;
        try_files $uri $uri/ /index.html;
    }
    
    # API 요청을 백엔드로 프록시
    location /api/ {
        proxy_pass http://backend-server.com;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 앱 환경에서의 차이점

모바일 앱의 경우는 웹과 다른 특성을 가집니다:

- **CORS 제한 없음**: 백엔드 서버에 직접적으로 API 호출 가능
- **네이티브 코드**: 웹과는 다르게 운영체제에서 직접 실행되는 네이티브 코드로 구성
- **앱 권한 모델**: 인터넷 접근, 위치 정보, 카메라 등의 권한을 사용자가 승인
- **앱 스토어 검증**: 사용자가 명시적으로 설치한 앱만 실행되며, 앱 스토어의 검증을 거침

## 결론

CORS는 웹 애플리케이션이 MVC에서 CSR 구조로 진화하면서 필연적으로 등장한 보안 메커니즘입니다. 단순히 백엔드에서 CORS 헤더를 설정하는 것보다는, **리버스 프록시를 통해 아키텍처 레벨에서 해결하는 것이 더 안전하고 효율적**입니다.

리버스 프록시 접근법은:
- CORS 문제를 근본적으로 해결하고
- 보안을 강화하며  
- 추가적인 인프라 기능을 제공합니다

현대 웹 애플리케이션 개발에서 리버스 프록시는 선택이 아닌 필수 요소가 되었습니다.

## 참고 자료

- [MDN - CORS](https://developer.mozilla.org/ko/docs/Web/HTTP/CORS)