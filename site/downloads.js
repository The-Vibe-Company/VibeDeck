(function (root) {
  'use strict';

  var RELEASE_API_URL = 'https://api.github.com/repos/The-Vibe-Company/VibeDeck/releases/latest';
  var DOWNLOAD_PATH_PREFIX = '/The-Vibe-Company/VibeDeck/releases/download/';
  var PLATFORM_LABELS = { macos: 'macOS', windows: 'Windows' };
  var REQUEST_TIMEOUT_MS = 10000;
  var DOWNLOAD_LOCK_MS = 1200;
  var DEFAULT_RATE_LIMIT_DELAY_MS = 60000;

  function detectPlatform(navigatorLike) {
    var navigatorValue = navigatorLike || {};
    var platform = String(
      (navigatorValue.userAgentData && navigatorValue.userAgentData.platform) ||
      navigatorValue.platform ||
      '',
    ).toLowerCase();
    var userAgent = String(navigatorValue.userAgent || '').toLowerCase();
    var isMobile = /android|iphone|ipad|ipod|mobile|windows phone/.test(userAgent);
    var isTouchMac = platform === 'macintel' && Number(navigatorValue.maxTouchPoints || 0) > 1;

    if (isMobile || isTouchMac) return null;
    if (platform.indexOf('win') !== -1 || userAgent.indexOf('windows') !== -1) return 'windows';
    if (platform.indexOf('mac') !== -1 || userAgent.indexOf('macintosh') !== -1) return 'macos';
    return null;
  }

  function validateAssetUrl(asset, releaseTag, extension) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') {
      throw new Error('Asset de release invalide.');
    }
    if (!asset.name.toLowerCase().endsWith(extension)) {
      throw new Error('Extension d’asset inattendue.');
    }

    var url = new URL(asset.browser_download_url);
    var expectedPrefix = DOWNLOAD_PATH_PREFIX + encodeURIComponent(releaseTag) + '/';
    var encodedName = url.pathname.slice(expectedPrefix.length);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      !url.pathname.startsWith(expectedPrefix) ||
      url.search !== '' ||
      url.hash !== '' ||
      decodeURIComponent(encodedName) !== asset.name
    ) {
      throw new Error('URL de téléchargement GitHub invalide.');
    }
    return url.href;
  }

  function extractDownloadUrls(release) {
    if (
      !release ||
      release.draft !== false ||
      release.prerelease !== false ||
      typeof release.tag_name !== 'string' ||
      !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
      !Array.isArray(release.assets) ||
      release.assets.length > 100
    ) {
      throw new Error('Dernière release GitHub invalide.');
    }

    function selectOne(extension) {
      var candidates = release.assets.filter(function (asset) {
        return typeof asset.name === 'string' && asset.name.toLowerCase().endsWith(extension);
      });
      if (candidates.length !== 1) {
        throw new Error('La release doit contenir exactement un asset ' + extension + '.');
      }
      return validateAssetUrl(candidates[0], release.tag_name, extension);
    }

    return Object.freeze({ macos: selectOne('.dmg'), windows: selectOne('.exe') });
  }

  function applyPlatformPreference(buttons, group, platform) {
    buttons.forEach(function (button) {
      var preferred = button.dataset.downloadPlatform === platform;
      button.classList.remove('btn-amber', 'btn-ghost');
      button.classList.add(preferred ? 'btn-amber' : 'btn-ghost');
    });
    if (platform) {
      var preferredButton = buttons.find(function (button) {
        return button.dataset.downloadPlatform === platform;
      });
      if (preferredButton && group.firstElementChild !== preferredButton) {
        group.insertBefore(preferredButton, group.firstElementChild);
      }
    }
  }

  function createDownloadController(options) {
    var buttons = Array.from(options.buttons || []);
    var group = options.group;
    var status = options.status;
    var fetchImpl = options.fetchImpl;
    var locationLike = options.location;
    var AbortControllerImpl = options.AbortControllerImpl || root.AbortController;
    var setTimeoutImpl = options.setTimeoutImpl || root.setTimeout;
    var clearTimeoutImpl = options.clearTimeoutImpl || root.clearTimeout;
    var nowImpl = options.nowImpl || Date.now;
    var requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    var downloadLockMs = options.downloadLockMs || DOWNLOAD_LOCK_MS;
    var platform = detectPlatform(options.navigator);
    var assets = null;
    var assetsPromise = null;
    var clickPending = false;
    var retryNotBefore = 0;

    if (
      buttons.length !== 2 ||
      buttons.filter(function (button) { return button.dataset.downloadPlatform === 'macos'; }).length !== 1 ||
      buttons.filter(function (button) { return button.dataset.downloadPlatform === 'windows'; }).length !== 1 ||
      !group ||
      !status ||
      typeof fetchImpl !== 'function' ||
      typeof AbortControllerImpl !== 'function' ||
      typeof setTimeoutImpl !== 'function' ||
      typeof clearTimeoutImpl !== 'function' ||
      typeof nowImpl !== 'function' ||
      !locationLike ||
      typeof locationLike.assign !== 'function'
    ) {
      throw new Error('Contrôles de téléchargement incomplets.');
    }

    applyPlatformPreference(buttons, group, platform);
    setStatus(
      platform ? PLATFORM_LABELS[platform] + ' détecté. Choisissez votre téléchargement.' : 'Choisissez votre plateforme.',
      'ready',
    );

    function setStatus(message, state) {
      status.textContent = message;
      status.dataset.state = state;
    }

    function setBusy(isBusy) {
      buttons.forEach(function (button) {
        button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
      });
    }

    function setControlsDisabled(isDisabled) {
      buttons.forEach(function (button) {
        button.disabled = isDisabled;
      });
    }

    function rateLimitResetAt(response) {
      if (!response || (response.status !== 403 && response.status !== 429)) return 0;
      var headers = response.headers;
      var retryAfter = headers && typeof headers.get === 'function' ? Number(headers.get('retry-after')) : NaN;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return nowImpl() + Math.min(retryAfter * 1000, 3600000);
      }
      var resetAt = headers && typeof headers.get === 'function' ? Number(headers.get('x-ratelimit-reset')) * 1000 : NaN;
      if (Number.isFinite(resetAt) && resetAt > nowImpl()) {
        return Math.min(resetAt, nowImpl() + 3600000);
      }
      return nowImpl() + DEFAULT_RATE_LIMIT_DELAY_MS;
    }

    function fetchLatestRelease() {
      var controller = new AbortControllerImpl();
      var timeoutId = setTimeoutImpl(function () { controller.abort(); }, requestTimeoutMs);
      return Promise.resolve()
        .then(function () {
          return fetchImpl(RELEASE_API_URL, {
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          });
        })
        .then(function (response) {
          if (!response || response.ok !== true || typeof response.json !== 'function') {
            retryNotBefore = Math.max(retryNotBefore, rateLimitResetAt(response));
            throw new Error('Réponse GitHub indisponible.');
          }
          return response.json();
        })
        .finally(function () {
          clearTimeoutImpl(timeoutId);
        });
    }

    function resolveAssets() {
      if (assets) return Promise.resolve(assets);
      if (assetsPromise) return assetsPromise;

      setBusy(true);
      setStatus('Préparation des téléchargements…', 'loading');
      assetsPromise = fetchLatestRelease()
        .then(function (release) {
          assets = extractDownloadUrls(release);
          setStatus(
            platform ? PLATFORM_LABELS[platform] + ' détecté. Téléchargements prêts.' : 'Téléchargements prêts.',
            'ready',
          );
          return assets;
        })
        .catch(function (error) {
          assetsPromise = null;
          setStatus('Téléchargement indisponible pour le moment. Réessayez.', 'error');
          throw error;
        })
        .finally(function () {
          setBusy(false);
        });
      return assetsPromise;
    }

    function handleDownload(event) {
      if (clickPending) return Promise.resolve();
      var selectedPlatform = event.currentTarget.dataset.downloadPlatform;
      if (!PLATFORM_LABELS[selectedPlatform]) return Promise.resolve();
      if (retryNotBefore > nowImpl()) {
        setStatus('GitHub limite temporairement les demandes. Réessayez dans quelques minutes.', 'error');
        return Promise.resolve();
      }

      clickPending = true;
      setControlsDisabled(true);
      event.currentTarget.setAttribute('aria-busy', 'true');
      setStatus('Préparation du téléchargement pour ' + PLATFORM_LABELS[selectedPlatform] + '…', 'loading');
      var navigationStarted = false;
      return resolveAssets()
        .then(function (resolvedAssets) {
          setStatus('Téléchargement pour ' + PLATFORM_LABELS[selectedPlatform] + ' lancé.', 'ready');
          locationLike.assign(resolvedAssets[selectedPlatform]);
          navigationStarted = true;
        })
        .catch(function () {
          if (status.dataset.state !== 'error') {
            setStatus('Le téléchargement n’a pas pu démarrer. Réessayez.', 'error');
          }
        })
        .finally(function () {
          event.currentTarget.setAttribute('aria-busy', 'false');
          if (navigationStarted) {
            setTimeoutImpl(function () {
              clickPending = false;
              setControlsDisabled(false);
            }, downloadLockMs);
          } else {
            clickPending = false;
            setControlsDisabled(false);
          }
        });
    }

    buttons.forEach(function (button) {
      button.addEventListener('click', handleDownload);
    });

    return Object.freeze({
      platform: platform,
      ready: Promise.resolve(null),
    });
  }

  function init(documentLike, navigatorLike, fetchImpl, locationLike) {
    return createDownloadController({
      buttons: documentLike.querySelectorAll('[data-download-platform]'),
      group: documentLike.getElementById('download-actions'),
      status: documentLike.getElementById('download-status'),
      navigator: navigatorLike,
      fetchImpl: fetchImpl,
      location: locationLike,
      AbortControllerImpl: root.AbortController,
      setTimeoutImpl: root.setTimeout.bind(root),
      clearTimeoutImpl: root.clearTimeout.bind(root),
      nowImpl: Date.now,
    });
  }

  var api = Object.freeze({
    createDownloadController: createDownloadController,
    detectPlatform: detectPlatform,
    extractDownloadUrls: extractDownloadUrls,
    init: init,
  });
  root.VibeDeckDownloads = api;

  if (root.document && root.navigator && root.fetch && root.location) {
    var start = function () {
      init(root.document, root.navigator, root.fetch.bind(root), root.location);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof globalThis === 'undefined' ? this : globalThis);
