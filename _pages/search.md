---
title: Search
layout: home
permalink: /search/
author_profile: true
sidebar:
  nav: "main"
---

<div class="search-form" style="margin-bottom: 2rem;">
  <input type="search" id="search-input" placeholder="Search posts..." style="width: 100%; padding: 0.75rem; font-size: 1rem; border: 2px solid #ccc; border-radius: 4px; outline: none;">
</div>

<script>
document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('search-input');
  const posts = document.querySelectorAll('.list__item article, .archive__item');
  
  searchInput.addEventListener('input', function() {
    const searchTerm = this.value.toLowerCase().trim();
    
    posts.forEach(function(post) {
      const title = post.querySelector('h2 a, .archive__item-title a');
      const excerpt = post.querySelector('.archive__item-excerpt');
      const meta = post.querySelector('.page__meta, .archive__item-teaser');
      
      let shouldShow = searchTerm === '';
      
      if (!shouldShow && title) {
        shouldShow = title.textContent.toLowerCase().includes(searchTerm);
      }
      
      if (!shouldShow && excerpt) {
        shouldShow = excerpt.textContent.toLowerCase().includes(searchTerm);
      }
      
      if (!shouldShow && meta) {
        shouldShow = meta.textContent.toLowerCase().includes(searchTerm);
      }
      
      const listItem = post.closest('.list__item') || post.closest('.archive__item');
      if (listItem) {
        listItem.style.display = shouldShow ? 'block' : 'none';
      } else {
        post.style.display = shouldShow ? 'block' : 'none';
      }
    });
  });
  
  // Focus search input on page load
  searchInput.focus();
});
</script>