import createHook from '@/createHook';
import { getResponseCache } from '@/storage/responseCache';
import { debounce, getHandlerMethod, getStatesHook, isNumber, key, noop, sloughConfig, _self } from '@/utils/helper';
import myAssert from '@/utils/myAssert';
import {
  AlovaMethodHandler,
  CompleteHandler,
  ErrorHandler,
  ExportedType,
  FetcherHookConfig,
  FetchRequestState,
  FrontRequestHookConfig,
  FrontRequestState,
  Progress,
  SuccessHandler,
  UseHookConfig,
  WatcherHookConfig
} from '~/typings';
import Alova from '../Alova';
import Method from '../Method';
import {
  deleteAttr,
  falseValue,
  forEach,
  isArray,
  isSSR,
  promiseCatch,
  pushItem,
  trueValue,
  undefinedValue
} from '../utils/variables';
import useHookToSendRequest from './useHookToSendRequest';

const refCurrent = <T>(ref: { current: T }) => ref.current;
/**
 * 创建请求状态，统一处理useRequest、useWatcher、useFetcher中一致的逻辑
 * 该函数会调用statesHook的创建函数来创建对应的请求状态
 * 当该值为空时，表示useFetcher进入的，此时不需要data状态和缓存状态
 * @param alovaInstance alova对象
 * @param methodInstance 请求方法对象
 * @param useHookConfig hook请求配置对象
 * @param initialData 初始data数据
 * @param immediate 是否立即发起请求
 * @param watchingStates 被监听的状态，如果未传入，直接调用handleRequest
 * @param debounceDelay 请求发起的延迟时间
 * @returns 当前的请求状态、操作函数及事件绑定函数
 */
export default function createRequestState<S, E, R, T, RC, RE, RH, UC extends UseHookConfig>(
  hookType: 1 | 2 | 3,
  alovaInstance: Alova<S, E, RC, RE, RH>,
  methodHandler: Method<S, E, R, T, RC, RE, RH> | AlovaMethodHandler<S, E, R, T, RC, RE, RH>,
  useHookConfig: UC,
  initialData?: any,
  immediate = falseValue,
  watchingStates?: E[],
  debounceDelay: WatcherHookConfig<S, E, R, T, RC, RE, RH>['debounce'] = 0
) {
  useHookConfig = { ...useHookConfig }; // 复制一份config，防止外部传入相同useHookConfig导致vue2情况下的状态更新错乱问题
  const statesHook = getStatesHook(alovaInstance);
  myAssert(!!statesHook, '`statesHook` is not found on alova instance.');
  const {
    create,
    export: stateExport,
    effectRequest,
    update,
    memorize = _self,
    ref = val => ({ current: val })
  } = statesHook;
  let initialLoading = falseValue;

  // 当立即发送请求时，需要通过是否强制请求和是否有缓存来确定初始loading值，这样做有以下两个好处：
  // 1. 在react下立即发送请求可以少渲染一次
  // 2. SSR渲染的html中，其初始视图为loading状态的，避免在客户端展现时的loading视图闪动
  if (immediate) {
    const cachedResponse: R | undefined = getResponseCache(alovaInstance.id, key(getHandlerMethod(methodHandler))),
      forceRequestFinally = sloughConfig(
        (useHookConfig as FrontRequestHookConfig<S, E, R, T, RC, RE, RH> | FetcherHookConfig).force ?? falseValue
      );
    initialLoading = !!forceRequestFinally || !cachedResponse;
  }

  const hookInstance = refCurrent(ref(createHook(hookType, useHookConfig))),
    progress: Progress = {
      total: 0,
      loaded: 0
    },
    // 将外部传入的受监管的状态一同放到frontStates集合中
    { managedStates = {} } = useHookConfig as FrontRequestHookConfig<S, E, R, T, RC, RE, RH>,
    frontStates = {
      ...managedStates,
      data: create(initialData, hookInstance),
      loading: create(initialLoading, hookInstance),
      error: create(undefinedValue as Error | undefined, hookInstance),
      downloading: create({ ...progress }, hookInstance),
      uploading: create({ ...progress }, hookInstance)
    },
    hasWatchingStates = watchingStates !== undefinedValue,
    // 初始化请求事件
    // 统一的发送请求函数
    handleRequest = (
      handler: Method<S, E, R, T, RC, RE, RH> | AlovaMethodHandler<S, E, R, T, RC, RE, RH> = methodHandler,
      sendCallingArgs?: any[],
      updateCacheState?: boolean
    ) => useHookToSendRequest(hookInstance, handler, sendCallingArgs, updateCacheState),
    // 以捕获异常的方式调用handleRequest
    // 捕获异常避免异常继续向外抛出
    wrapEffectRequest = () => {
      promiseCatch(handleRequest(), noop);
    };

  // react中每次执行函数都需要重置以下项
  hookInstance.fs = frontStates;
  hookInstance.sh = [];
  hookInstance.eh = [];
  hookInstance.ch = [];
  hookInstance.c = useHookConfig;
  // 在服务端渲染时不发送请求
  if (!isSSR) {
    effectRequest(
      {
        handler:
          // watchingStates为数组时表示监听状态（包含空数组），为undefined时表示不监听状态
          hasWatchingStates
            ? debounce(wrapEffectRequest, (changedIndex?: number) =>
                isNumber(changedIndex) ? (isArray(debounceDelay) ? debounceDelay[changedIndex] : debounceDelay) : 0
              )
            : wrapEffectRequest,
        removeStates: () => forEach(hookInstance.rf, fn => fn()),
        saveStates: (states: FrontRequestState) => forEach(hookInstance.sf, fn => fn(states)),
        frontStates: frontStates,
        watchingStates,
        immediate: immediate ?? trueValue
      },
      hookInstance
    );
  }

  const exportedStates = {
    loading: stateExport(frontStates.loading, hookInstance) as unknown as ExportedType<boolean, S>,
    data: stateExport(frontStates.data, hookInstance) as unknown as ExportedType<R, S>,
    error: stateExport(frontStates.error, hookInstance) as unknown as ExportedType<Error | null, S>,
    downloading: stateExport(frontStates.downloading, hookInstance) as unknown as ExportedType<Progress, S>,
    uploading: stateExport(frontStates.uploading, hookInstance) as unknown as ExportedType<Progress, S>
  };

  type PartialFrontRequestState = Partial<FrontRequestState<boolean, R, Error | undefined, Progress, Progress>>;
  type PartialFetchRequestState = Partial<FetchRequestState<boolean, Error | undefined, Progress, Progress>>;
  return {
    ...exportedStates,
    onSuccess(handler: SuccessHandler<S, E, R, T, RC, RE, RH>) {
      pushItem(hookInstance.sh, handler);
    },
    onError(handler: ErrorHandler<S, E, R, T, RC, RE, RH>) {
      pushItem(hookInstance.eh, handler);
    },
    onComplete(handler: CompleteHandler<S, E, R, T, RC, RE, RH>) {
      pushItem(hookInstance.ch, handler);
    },
    update: memorize((newStates: PartialFrontRequestState | PartialFetchRequestState) => {
      // 当useFetcher调用时，其fetching使用的是loading，更新时需要转换过来
      const { fetching } = newStates as PartialFetchRequestState;
      if (fetching) {
        (newStates as PartialFrontRequestState).loading = fetching;
        deleteAttr(newStates as PartialFetchRequestState, 'fetching');
      }
      update(newStates, frontStates, hookInstance);
    }),
    abort: memorize(() => hookInstance.ar(), trueValue),

    /**
     * 通过执行该方法来手动发起请求
     * @param sendCallingArgs 调用send函数时传入的参数
     * @param methodInstance 方法对象
     * @param isFetcher 是否为isFetcher调用
     * @returns 请求promise
     */
    send: memorize((sendCallingArgs?: any[], methodInstance?: Method<S, E, R, T, RC, RE, RH>, isFetcher?: boolean) =>
      handleRequest(methodInstance, sendCallingArgs, isFetcher)
    ),

    /** 为兼容options框架，如vue2、原生小程序等，将config对象原样导出 */
    _$c: useHookConfig
  };
}
