#!/usr/bin/env python3
"""
이미지 다운로드 스크립트
마크다운 파일에서 외부 이미지 URL을 찾아 다운로드하고 로컬 경로로 변환합니다.

사용법:
    python scripts/download_images.py                    # 모든 포스트 처리
    python scripts/download_images.py _posts/2025-01-18-my-post.md  # 특정 파일만
    python scripts/download_images.py --figure           # figure include로 변환
"""

import os
import re
import sys
import hashlib
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse, unquote

# 프로젝트 루트 디렉토리
PROJECT_ROOT = Path(__file__).parent.parent
POSTS_DIR = PROJECT_ROOT / "_posts"
IMAGES_DIR = PROJECT_ROOT / "assets" / "images" / "posts"

# 외부 이미지 URL 패턴 (http/https)
IMAGE_PATTERN = re.compile(
    r'!\[([^\]]*)\]\((https?://[^)\s]+)\)',
    re.IGNORECASE
)

# 지원하는 이미지 확장자
SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'}


def ensure_images_dir():
    """이미지 디렉토리 생성"""
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def get_extension_from_url(url: str) -> str:
    """URL에서 확장자 추출"""
    parsed = urlparse(url)
    path = unquote(parsed.path)
    ext = Path(path).suffix.lower()

    if ext in SUPPORTED_EXTENSIONS:
        return ext

    # 확장자가 없거나 지원하지 않는 경우 기본값
    return '.jpg'


def generate_filename(url: str, alt_text: str = "") -> str:
    """이미지 파일명 생성"""
    # URL의 마지막 부분에서 파일명 추출 시도
    parsed = urlparse(url)
    original_name = Path(unquote(parsed.path)).stem

    # 파일명 정리 (영문, 숫자, 하이픈만)
    clean_name = re.sub(r'[^a-zA-Z0-9\-]', '-', original_name)
    clean_name = re.sub(r'-+', '-', clean_name).strip('-').lower()

    if clean_name and len(clean_name) > 3:
        base_name = clean_name[:50]  # 최대 50자
    elif alt_text:
        # alt 텍스트에서 파일명 생성
        clean_alt = re.sub(r'[^a-zA-Z0-9\-]', '-', alt_text)
        clean_alt = re.sub(r'-+', '-', clean_alt).strip('-').lower()
        base_name = clean_alt[:50] if clean_alt else 'image'
    else:
        # URL 해시로 파일명 생성
        base_name = hashlib.md5(url.encode()).hexdigest()[:12]

    ext = get_extension_from_url(url)
    return f"{base_name}{ext}"


def download_image(url: str, save_path: Path) -> bool:
    """이미지 다운로드"""
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        request = urllib.request.Request(url, headers=headers)

        with urllib.request.urlopen(request, timeout=30) as response:
            with open(save_path, 'wb') as f:
                f.write(response.read())

        print(f"  ✓ 다운로드 완료: {save_path.name}")
        return True

    except urllib.error.HTTPError as e:
        print(f"  ✗ HTTP 에러 {e.code}: {url}")
    except urllib.error.URLError as e:
        print(f"  ✗ URL 에러: {url} - {e.reason}")
    except Exception as e:
        print(f"  ✗ 다운로드 실패: {url} - {e}")

    return False


def process_markdown_file(filepath: Path, use_figure: bool = False) -> bool:
    """마크다운 파일 처리"""
    print(f"\n📄 처리 중: {filepath.name}")

    content = filepath.read_text(encoding='utf-8')
    original_content = content

    matches = IMAGE_PATTERN.findall(content)

    if not matches:
        print("  → 외부 이미지 없음")
        return False

    print(f"  → {len(matches)}개 외부 이미지 발견")

    for alt_text, url in matches:
        filename = generate_filename(url, alt_text)
        save_path = IMAGES_DIR / filename

        # 중복 파일명 처리
        counter = 1
        while save_path.exists():
            stem = save_path.stem
            ext = save_path.suffix
            save_path = IMAGES_DIR / f"{stem}-{counter}{ext}"
            counter += 1

        if download_image(url, save_path):
            # 로컬 경로 생성
            local_path = f"/assets/images/posts/{save_path.name}"

            if use_figure:
                # figure include로 변환
                old_pattern = f"![{alt_text}]({url})"
                new_pattern = (
                    f'{{% include figure image_path="{local_path}" '
                    f'alt="{alt_text}" caption="{alt_text}" %}}'
                )
            else:
                # 기본 마크다운 유지
                old_pattern = f"![{alt_text}]({url})"
                new_pattern = f"![{alt_text}]({local_path})"

            content = content.replace(old_pattern, new_pattern)

    # 변경사항이 있으면 파일 저장
    if content != original_content:
        filepath.write_text(content, encoding='utf-8')
        print("  ✓ 파일 업데이트 완료")
        return True

    return False


def main():
    """메인 함수"""
    ensure_images_dir()

    use_figure = '--figure' in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith('--')]

    if args:
        # 특정 파일 처리
        files = [Path(f) for f in args if f.endswith('.md')]
    else:
        # 모든 포스트 처리
        files = list(POSTS_DIR.glob('*.md'))

    if not files:
        print("처리할 마크다운 파일이 없습니다.")
        return

    print(f"🚀 이미지 다운로드 시작 (figure 모드: {'ON' if use_figure else 'OFF'})")
    print(f"   대상 파일: {len(files)}개")

    processed = 0
    for filepath in sorted(files):
        if process_markdown_file(filepath, use_figure):
            processed += 1

    print(f"\n✅ 완료! {processed}개 파일 처리됨")
    print(f"   이미지 저장 위치: {IMAGES_DIR}")


if __name__ == "__main__":
    main()
