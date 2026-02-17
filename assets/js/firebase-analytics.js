/**
 * Firebase Analytics Module
 * - 전체 방문자 수 (Today/누적)
 * - 포스트별 조회수
 * - 좋아요 기능
 */
(function() {
  'use strict';

  // Firestore 모듈 import (동적)
  let doc, getDoc, setDoc, updateDoc, increment, collection, serverTimestamp, deleteDoc;

  // 상태
  let db = null;
  let visitorId = null;
  let isInitialized = false;

  // 초기화
  async function init() {
    try {
      // Firebase 모듈 로드 대기
      const firestoreModule = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
      doc = firestoreModule.doc;
      getDoc = firestoreModule.getDoc;
      setDoc = firestoreModule.setDoc;
      updateDoc = firestoreModule.updateDoc;
      increment = firestoreModule.increment;
      collection = firestoreModule.collection;
      serverTimestamp = firestoreModule.serverTimestamp;
      deleteDoc = firestoreModule.deleteDoc;

      // Firebase 초기화 대기
      await waitForFirebase();
      db = window.firebaseDb;

      // 방문자 ID 초기화
      await initVisitor();

      // 페이지뷰 추적
      await trackPageView();

      // 통계 표시
      await displayStats();

      // 좋아요 버튼 설정
      setupLikeButton();

      isInitialized = true;
    } catch (error) {
      console.error('Firebase Analytics 초기화 실패:', error);
    }
  }

  // Firebase 로드 대기
  function waitForFirebase() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50;

      const check = () => {
        if (window.firebaseDb && window.firebaseAuth) {
          resolve();
        } else if (attempts >= maxAttempts) {
          reject(new Error('Firebase 로드 타임아웃'));
        } else {
          attempts++;
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  // 방문자 ID 관리
  async function initVisitor() {
    visitorId = localStorage.getItem('visitorId');

    if (!visitorId) {
      try {
        const result = await window.signInAnonymously(window.firebaseAuth);
        visitorId = result.user.uid;
        localStorage.setItem('visitorId', visitorId);
      } catch (error) {
        // 익명 인증 실패 시 UUID 생성
        visitorId = 'anon_' + crypto.randomUUID();
        localStorage.setItem('visitorId', visitorId);
      }
    }
  }

  // 페이지뷰 추적
  async function trackPageView() {
    const postSlug = getPostSlug();

    // 전역 통계 업데이트
    await updateGlobalStats();

    // 포스트 페이지인 경우 조회수 업데이트
    if (postSlug) {
      await updatePostViews(postSlug);
    }
  }

  // 포스트 slug 추출
  function getPostSlug() {
    const path = window.location.pathname;
    // /categories/year/month/day/title/ 형식에서 slug 추출
    const match = path.match(/\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)/);
    if (match) {
      return match[4];
    }
    return null;
  }

  // 오늘 날짜 (KST)
  function getTodayDate() {
    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return kst.toISOString().split('T')[0];
  }

  // 전역 통계 업데이트
  async function updateGlobalStats() {
    // 세션당 한 번만 카운트
    if (sessionStorage.getItem('viewCounted')) {
      return;
    }

    try {
      const statsRef = doc(db, 'stats', 'global');
      const statsDoc = await getDoc(statsRef);
      const today = getTodayDate();

      if (statsDoc.exists()) {
        const data = statsDoc.data();

        if (data.lastResetDate !== today) {
          // 날짜가 바뀌면 todayViews 리셋
          await updateDoc(statsRef, {
            totalViews: increment(1),
            todayViews: 1,
            lastResetDate: today
          });
        } else {
          await updateDoc(statsRef, {
            totalViews: increment(1),
            todayViews: increment(1)
          });
        }
      } else {
        // 첫 방문자
        await setDoc(statsRef, {
          totalViews: 1,
          todayViews: 1,
          lastResetDate: today
        });
      }

      sessionStorage.setItem('viewCounted', 'true');
    } catch (error) {
      console.error('전역 통계 업데이트 실패:', error);
    }
  }

  // 포스트 조회수 업데이트
  async function updatePostViews(postSlug) {
    // 세션 내 중복 방지
    const viewedPosts = JSON.parse(sessionStorage.getItem('viewedPosts') || '[]');
    if (viewedPosts.includes(postSlug)) {
      return;
    }

    try {
      const postRef = doc(db, 'posts', postSlug);
      const postDoc = await getDoc(postRef);

      if (postDoc.exists()) {
        await updateDoc(postRef, {
          views: increment(1)
        });
      } else {
        await setDoc(postRef, {
          views: 1,
          likes: 0
        });
      }

      viewedPosts.push(postSlug);
      sessionStorage.setItem('viewedPosts', JSON.stringify(viewedPosts));
    } catch (error) {
      console.error('포스트 조회수 업데이트 실패:', error);
    }
  }

  // 통계 표시
  async function displayStats() {
    // 전역 통계 표시
    await displayGlobalStats();

    // 포스트 페이지인 경우 post-stats 위젯 삽입 및 표시
    const postSlug = getPostSlug();
    if (postSlug) {
      insertPostStatsWidget();
      await displayPostStats(postSlug);
    }
  }

  // 포스트 통계 위젯 동적 삽입
  function insertPostStatsWidget() {
    // 이미 존재하면 스킵
    if (document.getElementById('post-stats-widget')) return;

    // 포스트 컨텐츠 영역 찾기
    const pageContent = document.querySelector('.page__content');
    if (!pageContent) return;

    // post-stats 위젯 HTML 생성
    const widget = document.createElement('div');
    widget.id = 'post-stats-widget';
    widget.className = 'post-stats';
    widget.innerHTML = `
      <span class="post-views">
        <i class="fas fa-eye"></i>
        <span id="post-view-count">--</span> views
      </span>
      <button class="like-btn" id="like-btn" aria-label="Like this post">
        <i class="fas fa-heart"></i>
        <span id="like-count">--</span>
      </button>
    `;

    // 컨텐츠 끝에 삽입
    pageContent.appendChild(widget);
  }

  // 전역 통계 표시
  async function displayGlobalStats() {
    try {
      const statsRef = doc(db, 'stats', 'global');
      const statsDoc = await getDoc(statsRef);

      if (statsDoc.exists()) {
        const data = statsDoc.data();
        const today = getTodayDate();

        const todayViews = data.lastResetDate === today ? data.todayViews : 0;
        const totalViews = data.totalViews || 0;

        const todayEl = document.getElementById('today-views');
        const totalEl = document.getElementById('total-views');

        if (todayEl) todayEl.textContent = formatNumber(todayViews);
        if (totalEl) totalEl.textContent = formatNumber(totalViews);
      }
    } catch (error) {
      console.error('전역 통계 표시 실패:', error);
    }
  }

  // 포스트 통계 표시
  async function displayPostStats(postSlug) {
    try {
      const postRef = doc(db, 'posts', postSlug);
      const postDoc = await getDoc(postRef);

      const viewCountEl = document.getElementById('post-view-count');
      const likeCountEl = document.getElementById('like-count');
      const likeBtnEl = document.getElementById('like-btn');

      if (postDoc.exists()) {
        const data = postDoc.data();

        if (viewCountEl) viewCountEl.textContent = formatNumber(data.views || 0);
        if (likeCountEl) likeCountEl.textContent = formatNumber(data.likes || 0);
      } else {
        if (viewCountEl) viewCountEl.textContent = '0';
        if (likeCountEl) likeCountEl.textContent = '0';
      }

      // 좋아요 상태 확인
      if (likeBtnEl && visitorId) {
        const likedRef = doc(db, 'posts', postSlug, 'likedBy', visitorId);
        const likedDoc = await getDoc(likedRef);

        if (likedDoc.exists()) {
          likeBtnEl.classList.add('liked');
        }
      }
    } catch (error) {
      console.error('포스트 통계 표시 실패:', error);
    }
  }

  // 좋아요 버튼 설정
  function setupLikeButton() {
    const likeBtn = document.getElementById('like-btn');
    if (!likeBtn) return;

    likeBtn.addEventListener('click', async function() {
      if (!isInitialized || !visitorId) return;

      const postSlug = getPostSlug();
      if (!postSlug) return;

      // 클릭 중복 방지
      if (likeBtn.disabled) return;
      likeBtn.disabled = true;

      try {
        const isLiked = likeBtn.classList.contains('liked');

        if (isLiked) {
          await unlikePost(postSlug);
          likeBtn.classList.remove('liked');
        } else {
          await likePost(postSlug);
          likeBtn.classList.add('liked');
        }

        // 좋아요 수 새로고침
        await displayPostStats(postSlug);
      } catch (error) {
        console.error('좋아요 처리 실패:', error);
      } finally {
        likeBtn.disabled = false;
      }
    });
  }

  // 좋아요 추가
  async function likePost(postSlug) {
    const postRef = doc(db, 'posts', postSlug);
    const likedRef = doc(db, 'posts', postSlug, 'likedBy', visitorId);

    // 좋아요 기록 추가
    await setDoc(likedRef, {
      timestamp: serverTimestamp()
    });

    // 좋아요 수 증가
    const postDoc = await getDoc(postRef);
    if (postDoc.exists()) {
      await updateDoc(postRef, {
        likes: increment(1)
      });
    } else {
      await setDoc(postRef, {
        views: 0,
        likes: 1
      });
    }
  }

  // 좋아요 취소
  async function unlikePost(postSlug) {
    const postRef = doc(db, 'posts', postSlug);
    const likedRef = doc(db, 'posts', postSlug, 'likedBy', visitorId);

    // 좋아요 기록 삭제
    await deleteDoc(likedRef);

    // 좋아요 수 감소
    await updateDoc(postRef, {
      likes: increment(-1)
    });
  }

  // 숫자 포맷팅
  function formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  // DOM 로드 후 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
