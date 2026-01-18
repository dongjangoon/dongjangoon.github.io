---
layout: single
title: "Minimal Mistakes 이미지 기능 데모"
date: 2025-12-25 10:00:00 +0900
categories: blog
tags: [jekyll, minimal-mistakes, images]
excerpt: "Minimal Mistakes 테마에서 제공하는 Figure, Gallery, Header Image 등 다양한 이미지 기능 사용법을 알아봅니다."
---

## Minimal Mistakes 이미지 기능 사용법

이 포스트는 Minimal Mistakes 테마에서 제공하는 다양한 이미지 기능을 시연합니다.

## 1. Header Image (포스트 상단 이미지)

포스트 상단에 큰 이미지를 표시할 수 있습니다. 이 포스트의 front matter를 확인해보세요!

```yaml
header:
  image: /assets/images/headers/blog-header.png
  teaser: /assets/images/headers/blog-thumb.png
  caption: "Photo credit: [**Unsplash**](https://unsplash.com)"
```

## 2. Figure (캡션 있는 이미지)

### 기본 Figure

이미지에 캡션을 추가하려면 다음과 같이 작성합니다:

```liquid
{% raw %}{% include figure image_path="/assets/images/posts/example.png"
   alt="이미지 설명"
   caption="그림 1: 예제 이미지" %}{% endraw %}
```

**실제 사용 예제** (이미지가 있다면):
{% raw %}{% comment %}
{% include figure image_path="/assets/images/posts/prometheus-architecture.png"
   alt="Prometheus Architecture"
   caption="그림 1: Prometheus 전체 아키텍처 - Metrics 수집부터 시각화까지" %}
{% endcomment %}{% endraw %}

> 📝 **노트**: 이미지를 실제로 사용하려면 `assets/images/posts/` 디렉토리에 이미지를 추가하고 위의 주석을 해제하세요.

### 이미지 정렬

#### 좌측 정렬
```liquid
{% raw %}{% include figure image_path="/assets/images/posts/example.png"
   alt="설명" caption="왼쪽 정렬 이미지" class="align-left" %}{% endraw %}
```

텍스트가 이미지 오른쪽으로 흐릅니다. 이 방식은 작은 이미지를 본문에 자연스럽게 통합할 때 유용합니다.

#### 우측 정렬
```liquid
{% raw %}{% include figure image_path="/assets/images/posts/example.png"
   alt="설명" caption="오른쪽 정렬 이미지" class="align-right" %}{% endraw %}
```

텍스트가 이미지 왼쪽으로 흐릅니다.

#### 중앙 정렬
```liquid
{% raw %}{% include figure image_path="/assets/images/posts/example.png"
   alt="설명" caption="중앙 정렬 이미지" class="align-center" %}{% endraw %}
```

이미지가 페이지 중앙에 배치되고 텍스트는 위아래로 흐릅니다.

## 3. Gallery (이미지 갤러리)

여러 이미지를 그리드로 표시할 수 있습니다.

### Front Matter에 갤러리 정의
```yaml
gallery_monitoring:
  - url: /assets/images/gallery/dashboard-1.png
    image_path: /assets/images/gallery/dashboard-1.png
    alt: "Prometheus Dashboard"
    title: "Prometheus 메트릭 대시보드"
  - url: /assets/images/gallery/dashboard-2.png
    image_path: /assets/images/gallery/dashboard-2.png
    alt: "Grafana Dashboard"
    title: "Grafana 시각화 대시보드"
```

### 포스트에서 갤러리 표시
```liquid
{% raw %}{% include gallery id="gallery_monitoring" caption="Kubernetes 모니터링 대시보드 모음" %}{% endraw %}
```

**실제 갤러리** (이미지를 추가하면 표시됩니다):
{% raw %}{% comment %}
{% include gallery id="gallery_monitoring" caption="Kubernetes 모니터링 대시보드 예제" %}
{% endcomment %}{% endraw %}

### 갤러리 레이아웃 옵션

**2열 그리드**:
```liquid
{% raw %}{% include gallery id="gallery_monitoring" layout="half" %}{% endraw %}
```

**3열 그리드** (기본값):
```liquid
{% raw %}{% include gallery id="gallery_monitoring" %}{% endraw %}
```

## 4. 기본 Markdown 이미지

간단하게 이미지를 추가하려면:

```markdown
![Kubernetes Logo](/assets/images/posts/k8s-logo.png)
```

### 외부 이미지 자동 다운로드 테스트

아래 이미지는 외부 URL에서 자동으로 다운로드됩니다:

{% include figure image_path="/assets/images/posts/logo.png" alt="Kubernetes Logo" caption="Kubernetes Logo" %}

{% include figure image_path="/assets/images/posts/prometheus-logo.svg" alt="Prometheus Logo" caption="Prometheus Logo" %}

## 실전 활용 팁

### 1. 기술 블로그에서의 활용

**아키텍처 다이어그램**:
- 큰 다이어그램: Figure with center align
- 작은 다이어그램: Figure with left/right align

**스크린샷**:
- 여러 스크린샷: Gallery 사용
- 단일 스크린샷: Figure 사용

**코드 예제 이미지**:
- Terminal 스크린샷: Figure with caption

### 2. 이미지 크기 가이드

| 용도 | 권장 크기 | 비율 |
|------|----------|------|
| Header Image | 1280x600px | 2.13:1 |
| Teaser/Thumbnail | 500x300px | 1.67:1 |
| 본문 이미지 (전체 폭) | 1200px 폭 | 자유 |
| 본문 이미지 (정렬) | 600px 폭 | 자유 |
| 갤러리 이미지 | 800x600px | 4:3 |

### 3. 이미지 최적화

**ImageMagick 명령어**:
```bash
# Header 이미지 생성 (1280x600)
convert input.png -resize 1280x600^ -gravity center -extent 1280x600 header.png

# Thumbnail 생성 (500x300)
convert input.png -resize 500x300^ -gravity center -extent 500x300 thumb.png

# 본문 이미지 최적화 (최대 폭 1200px)
convert input.png -resize 1200x\> -quality 85 optimized.png
```

## 다음 단계

1. **이미지 준비**: 스크린샷, 다이어그램 등 필요한 이미지 준비
2. **이미지 업로드**: `assets/images/` 디렉토리에 저장
3. **포스트 작성**: 위의 예제를 참고하여 이미지 추가
4. **로컬 테스트**: `bundle exec jekyll serve`로 확인
5. **배포**: Git push

## 참고 자료

- [Minimal Mistakes 공식 문서](https://mmistakes.github.io/minimal-mistakes/docs/helpers/)
- [Jekyll Liquid 문법](https://jekyllrb.com/docs/liquid/)
- [이미지 최적화 가이드](https://developers.google.com/web/fundamentals/performance/optimizing-content-efficiency/image-optimization)

---

**💡 Tip**: 실제 이미지를 사용하려면 `assets/images/` 디렉토리에 이미지를 추가하고, 이 포스트의 주석 처리된 부분을 해제하세요!

---

*이 포스트는 Claude Code와 함께 작성했습니다.*
