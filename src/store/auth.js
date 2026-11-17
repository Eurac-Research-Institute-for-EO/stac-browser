import Auth from '../auth';
import i18n from '../i18n';
import AuthUtils from '../components/auth/utils';
import { Cookies } from '../browser-store';
import { hasText } from 'stac-js/src/utils.js';

const handleAuthError = async (cx, error) => {
  cx.commit('showGlobalError', {
    error,
    message: i18n.global.t('errors.authFailed')
  }, { root: true });
  await cx.dispatch('updateCredentials');
};

export default function getStore(router) {
  return {
    namespaced: true,
    state: {
      // Wrap in a function and use the getter instead of the state
      // Unfortunately, some auth libraries have internal state, which vuex doesn't like
      // and thus reports: "do not mutate vuex store state outside mutation handlers."
      method: () => new Auth(router),
      actions: [],
      credentials: null,
      // Headers set by the authentication method. They are kept separate from
      // the headers configured for the catalog through the `requestHeaders`
      // option so that they can be scoped to the catalog they belong to.
      headers: {},
      // The catalog URL the current credentials are valid for.
      scope: null,
      // The catalog URL a pending login is for. This is used when a request
      // fails before the catalog URL could be determined, e.g. when the
      // landing page of a catalog is protected.
      pendingScope: null,
      inProgress: false
    },
    getters: {
      method(state) {
        return state.method();
      },
      canAuthenticate(state, getters, rootState) {
        return AuthUtils.isSupported(getters.method, rootState);
      },
      isLoggedIn(state) {
        return state.credentials !== null;
      },
      showLogin(state, getters) {
        return !getters.isLoggedIn && state.inProgress;
      }
    },
    mutations: {
      setCredentials(state, credentials) {
        state.credentials = credentials; // e.g. Username + Password or a Bearer Token
      },
      setHeader(state, { key, value }) {
        if (typeof value === 'undefined') {
          delete state.headers[key];
        }
        else {
          state.headers[key] = value;
        }
      },
      resetHeaders(state) {
        state.headers = {};
      },
      setScope(state, scope) {
        state.scope = hasText(scope) ? scope : null;
      },
      setPendingScope(state, scope) {
        state.pendingScope = hasText(scope) ? scope : null;
      },
      setMethod(state, method) {
        state.method = () => method;
      },
      addAction(state, callback) {
        state.actions.push(callback);
      },
      resetActions(state) {
        state.actions = [];
      },
      setInProgress(state, inProgress = true) {
        state.inProgress = inProgress;
      }
    },
    actions: {
      async waitForAuth(cx) {
        if (Auth.equals(cx.getters.method, cx.rootState.authConfig)) {
          return;
        }
        await cx.dispatch('updateMethod', cx.rootState.authConfig);
      },
      async updateMethod(cx, config) {
        if (!Auth.equals(cx.getters.method, config)) {
          await cx.getters.method.close();
          // The headers of the previous method must not be sent with the new method.
          cx.commit('resetHeaders');
          cx.commit('setScope', null);
        }

        const changeListener = async (isLoggedIn, credentials) => {
          if (!isLoggedIn) {
            credentials = null;
          }
          await cx.dispatch('updateCredentials', credentials);
          // The transaction permissions may change with the credentials,
          // remove them so that they are checked again when needed.
          cx.commit('manager/resetPermissions', null, { root: true });
          if (isLoggedIn) {
            await cx.dispatch('executeActions');
          }
          else {
            await cx.dispatch('cancelActions');
          }
        };

        const newAuth = await Auth.create(router, config, changeListener);
        cx.commit('setMethod', newAuth);
        await newAuth.resume();
      },
      async requestLogin(cx) {
        if (cx.getters.isLoggedIn) {
          return;
        }
        cx.commit('setInProgress');
        try {
          await cx.getters.method.login();
        } catch(error) {
          handleAuthError(cx, error);
        }
      },
      async finalizeLogin(cx, credentials = null) {
        cx.commit('setInProgress', false);
        try {
          await cx.getters.method.confirmLogin(credentials);
        } catch(error) {
          handleAuthError(cx, error);
        }
      },
      async abortLogin(cx) {
        cx.commit('setInProgress', false);
        // The user actively declined to log in, so don't keep the pending
        // actions around for a (potentially much later) login.
        await cx.dispatch('cancelActions');
      },
      async requestLogout(cx) {
        if (!cx.getters.isLoggedIn) {
          return;
        }
        cx.commit('setInProgress');
        await cx.getters.method.logout();
      },
      async finalizeLogout(cx) {
        cx.commit('setInProgress', false);
        try {
          await cx.getters.method.confirmLogout();
        } catch(error) {
          handleAuthError(cx, error);
        }
      },
      // Format the value and add it to query parameters or headers
      async updateCredentials(cx, value = null) { // eslint-disable-line require-await
        cx.commit('setCredentials', value);
        const intent = cx.getters.method.updateStore(value);
        if (value) {
          // Bind the credentials to the catalog they were issued for. If the
          // catalog is not known yet, use the scope of the request that
          // triggered the login.
          cx.commit('setScope', cx.state.pendingScope || cx.rootGetters.credentialCatalogUrl);
          cx.commit('setPendingScope', null);
        }
        else {
          cx.commit('setScope', null);
          cx.commit('setPendingScope', null);
        }
        if (intent.query) {
          cx.commit('setQueryParameter', intent.query, { root: true });
        }
        else if (intent.header) {
          if (value) {
            cx.commit('setHeader', intent.header);
          }
          else {
            cx.commit('resetHeaders');
          }
        }
        else if (intent.cookie) {
          const cookie = new Cookies(true);
          cookie.setItem(intent.cookie.key, intent.cookie.value);
        }
        else if (!value) {
          cx.commit('resetHeaders');
        }
      },
      // Discards the credentials and authentication headers of the previous
      // catalog. This is called when the user switches to another catalog so
      // that its requests are never sent with credentials it doesn't own.
      async reset(cx) {
        await cx.dispatch('updateCredentials', null);
        await cx.dispatch('cancelActions');
        // Remove credentials stored by the authentication method itself,
        // e.g. the user data stored by the OIDC client. This does not trigger
        // a logout redirect.
        try {
          await cx.getters.method.close();
        } catch (error) {
          console.error(error);
        }
      },
      // Actions are either plain functions or objects with a `run` function
      // and an optional `cancel` function (see cancelActions).
      async executeActions(cx) { // eslint-disable-line require-await
        for (let action of cx.state.actions) {
          const run = typeof action === 'function' ? action : action.run;
          try {
            const p = run();
            if (p instanceof Promise) {
              p.catch(error => handleAuthError(cx, error));
            }
          } catch (error) {
            handleAuthError(cx, error);
          }
        }
        cx.commit('resetActions');
      },
      // Discards the pending actions, e.g. when the user aborts the login or logs out.
      // Notifies the actions through their `cancel` function so that pending
      // promises can settle instead of hanging around forever.
      async cancelActions(cx) { // eslint-disable-line require-await
        for (let action of cx.state.actions) {
          if (typeof action.cancel === 'function') {
            try {
              action.cancel();
            } catch (error) {
              console.error(error);
            }
          }
        }
        cx.commit('resetActions');
        cx.commit('setPendingScope', null);
      }
    }
  };
}
