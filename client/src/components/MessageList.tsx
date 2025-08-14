import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import type { DBMessage, DBMessageVersion } from '../db/db';
import { db, msgKey } from '../db/db';
import MediaModal from './MediaModal';
import { getInitials } from '../lib/ui';
import { ObjectUrlCache, mediaUrlKey, renderRichText } from './message/utils.tsx';
// удалены неиспользуемые импорты getMessageById/downloadMessageThumb

// Глобальный (на модуль) кэш ObjectURL, чтобы URL не пересоздавались при размонтировании/монтаже MessageList
const sharedUrlCache = new ObjectUrlCache();

// Hoisted, memoized video player to keep component identity stable across renders
const VideoPlayer = memo(
  ({
    src,
    type,
    poster,
    controls,
    autoPlay,
    muted,
    onClick,
    onError,
  }: {
    src: string
    type?: string
    poster?: string
    controls?: boolean
    autoPlay?: boolean
    muted?: boolean
    onClick?: () => void
    onError?: () => void
  }) => (
    <video
      className="w-full h-full object-contain"
      controls={controls}
      autoPlay={autoPlay}
      muted={muted}
      playsInline
      poster={poster}
      onClick={onClick}
      preload="metadata"
      onError={onError}
    >
      <source src={src} type={type} />
    </video>
  ),
  (prev, next) =>
    prev.src === next.src &&
    prev.type === next.type &&
    prev.poster === next.poster &&
    prev.controls === next.controls &&
    prev.autoPlay === next.autoPlay &&
    prev.muted === next.muted
);

type MessageListProps = {
  messages: DBMessage[];
  canLoadMoreTop: boolean;
  canLoadMoreBottom: boolean;
  onLoadMoreTop: () => Promise<void>;
  onLoadMoreBottom: () => Promise<void>;
  onRequestFile?: (msgId: number) => Promise<void>;
  onOpenGalleryAt?: (msgId: number) => void;
  onPickReply?: (m: DBMessage) => void;
  activeEntity?: any;
};



function MessageList({
  messages,
  canLoadMoreTop,
  canLoadMoreBottom,
  onLoadMoreTop,
  onLoadMoreBottom,
  onRequestFile,
  onOpenGalleryAt,
  onPickReply: _onPickReply,
  activeEntity: _activeEntity,
}: MessageListProps) {
  // Автопрокрутка отключена. Загружаем диалог и сразу показываем последнее сообщение.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingTop, setLoadingTop] = useState(false);
  const atBottomRef = useRef(true);
  const [loadingBottom, setLoadingBottom] = useState(false);
  const [dialogAvatar, setDialogAvatar] = useState<string | undefined>(undefined);
  const [userAvatars, setUserAvatars] = useState<Map<string, string | undefined>>(new Map());
  const requestedFilesRef = useRef<Set<number>>(new Set());
  const currentDialogId = useMemo(() => messages[messages.length - 1]?.dialogId, [messages]);
  const prevDialogIdRef = useRef<string | undefined>(undefined);
  const didInitialScrollRef = useRef<Map<string, boolean>>(new Map());

  // ObjectURL cache management
  const getMsgBlobUrl = (m: DBMessage, kind: 'full' | 'thumb'): string | undefined => {
    const anyM = m as any;
    const blob: Blob | undefined = kind === 'full' ? anyM.mediaBlob : anyM.mediaThumbBlob;
    const key = mediaUrlKey(m, kind);
    const size = typeof m.mediaSize === 'number' ? m.mediaSize : undefined;
    const mime = m.mediaMime;
    return sharedUrlCache.get(key, blob, { size, mime }) || undefined;
  };

  // Мемо-обёртки объявлены после определения локальных компонентов (см. ниже)

  // Memo-компоненты объявлены ниже, после определения MessageItem/Album

  // VideoPlayer вынесен наверх файла

  // Кэш ObjectURL общий для модуля; отдельной очистки при размонтировании не требуется.

  // Одиночное сообщение
  const MessageItem = ({ m, showAvatar }: { m: DBMessage; showAvatar: boolean }) => {
    const isService = Boolean((m as any).serviceType);
    return (
      <div data-msg-id={m.msgId} className={`my-2 flex ${m.out ? 'justify-end' : 'justify-start'}`}>
        {!m.out && showAvatar && !isService && <Avatar senderName={m.senderName} fromId={m.fromId} />}
        <div
          className={`max-w-[85vw] md:max-w-[560px] border border-gray-200 rounded-xl px-3 py-2 ${
            m.out ? 'bg-blue-100' : 'bg-white'
          } ${m.deleted ? 'opacity-70' : ''}`}
        >
          {!m.out && showAvatar && m.senderName && !isService && (
            <div className="text-xs text-sky-700 font-medium mb-0.5">{m.senderName}</div>
          )}
          {isService ? (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <span aria-hidden>{(m as any).callIsVideo ? '🎥' : '📞'}</span>
              <span>
                {(() => {
                  const reason = (m as any).callReason as any;
                  const outgoing = Boolean((m as any).callOutgoing);
                  if (reason === 'missed') return 'Пропущенный звонок';
                  if (reason === 'declined') return outgoing ? 'Исходящий звонок отклонён' : 'Входящий звонок отклонён';
                  if (reason === 'busy') return 'Собеседник занят';
                  const dir = outgoing ? 'Исходящий' : 'Входящий';
                  const base = `${dir} ${(m as any).callIsVideo ? 'видеозвонок' : 'аудиозвонок'}`;
                  const dur = (m as any).callDuration;
                  return dur > 0 ? `${base} · ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}` : base;
                })()}
              </span>
            </div>
          ) : (
            <>
              {(m as any).forwardedFrom && (
                <div className="mb-1 text-xs text-gray-500">Переслано от {(m as any).forwardedFrom}</div>
              )}
              {typeof (m as any).replyToMsgId === 'number' && (
                <div className="mb-1">
                  <ReplyPreview dialogId={m.dialogId} msgId={Number((m as any).replyToMsgId)} />
                </div>
              )}
              {renderRichText(m.text, (m as any).entities)}
              <Media m={m} />
            </>
          )}
          <div className="mt-1 flex items-center gap-2">
            <div className="text-[11px] text-gray-400">{new Date(m.date * 1000).toLocaleString()}</div>
            {m.edited && (
              <button className="text-[11px] text-blue-500 hover:underline" onClick={() => openHistory(m)}>
                (изменено)
              </button>
            )}
            {m.deleted && <span className="text-[11px] text-red-500">(удалено)</span>}
          </div>
        </div>
      </div>
    );
  };

  // Media modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSrc, setModalSrc] = useState<string | undefined>(undefined);
  const [modalKind, setModalKind] = useState<'image' | 'video'>('image');
  const [modalTitle, setModalTitle] = useState<string | undefined>();

  const closeMediaModal = () => {
    setModalOpen(false);
    setModalSrc(undefined);
  };

  // Versions history modal state
  const [histOpen, setHistOpen] = useState(false);
  const [histItems, setHistItems] = useState<DBMessageVersion[]>([]);
  const [histFor, setHistFor] = useState<DBMessage | undefined>(undefined);

  const openHistory = useCallback(async (m: DBMessage) => {
    setHistFor(m);
    setHistOpen(true);
    try {
      const items = await db.messageVersions
        .where({ dialogId: m.dialogId, msgId: m.msgId })
        .toArray();
      setHistItems(items);
    } catch {
      setHistItems([]);
    }
  }, []);

  // Avatar component
  const Avatar = ({ senderName, fromId }: { senderName?: string; fromId?: string }) => {
    const avatar = fromId ? userAvatars.get(fromId) : dialogAvatar;
    return avatar ? (
      <img
        src={avatar}
        alt={senderName || 'avatar'}
        className="w-8 h-8 rounded-full object-cover mr-2 select-none"
        onError={() => {
          if (fromId && userAvatars.has(fromId)) {
            setUserAvatars((prev) => {
              const next = new Map(prev);
              next.set(fromId, undefined);
              return next;
            });
          } else {
            setDialogAvatar(undefined);
          }
        }}
      />
    ) : (
      <div className="w-8 h-8 rounded-full bg-sky-500 text-white flex items-center justify-center text-xs font-semibold mr-2 select-none">
        {getInitials(senderName)}
      </div>
    );
  };

  // Message groups (albums)
  const groups = useMemo(() => {
    const res: Array<{ key: string; items: DBMessage[] }> = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      const gid = (m as any).groupedId;
      if (gid) {
        const chunk: DBMessage[] = [m];
        let j = i + 1;
        while (j < messages.length && (messages[j] as any).groupedId === gid) {
          chunk.push(messages[j]);
          j++;
        }
        res.push({ key: `${gid}:${m.id}`, items: chunk });
        i = j;
      } else {
        res.push({ key: m.id, items: [m] });
        i++;
      }
    }
    return res;
  }, [messages]);

  // Media component
  const Media = ({ m }: { m: DBMessage }) => {
    const [videoFailed, setVideoFailed] = useState(false);
    const badge = (t: string) => (
      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
        {t}
      </span>
    );

    const openMedia = async (m: DBMessage) => {
      if (onOpenGalleryAt) {
        onOpenGalleryAt(m.msgId);
        return;
      }
      const anyM = m as any;
      setModalTitle(m.fileName || undefined);
      setModalKind(m.mediaType === 'video' || m.mediaType === 'video_note' ? 'video' : 'image');
      setModalSrc(
        anyM.mediaBlob ? getMsgBlobUrl(m, 'full') :
        anyM.mediaThumbBlob ? getMsgBlobUrl(m, 'thumb') :
        m.mediaThumb || undefined
      );
      setModalOpen(true);
      if (!anyM.mediaBlob && onRequestFile) {
        await onRequestFile(m.msgId);
      }
    };

    const observeFile = (el: Element | null) => {
      if (!el || !onRequestFile || requestedFilesRef.current.has(m.msgId)) return;
      const size = typeof m.mediaSize === 'number' ? m.mediaSize : undefined;
      if (size && size > 20 * 1024 * 1024) return;
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            requestedFilesRef.current.add(m.msgId);
            io.disconnect();
            onRequestFile(m.msgId);
          }
        },
        { root: scrollerRef.current, rootMargin: '150px' }
      );
      io.observe(el);
      return () => io.disconnect();
    };

    const fullUrl = getMsgBlobUrl(m, 'full');
    const thumbUrl = m.mediaThumb || getMsgBlobUrl(m, 'thumb');
    const box = 'mt-1 w-full overflow-hidden rounded bg-gray-100';
    const w = (m as any).mediaWidth as number | undefined;
    const h = (m as any).mediaHeight as number | undefined;
    // Lock ratio per message on first render to prevent reflow when media/preview changes later
    const ratioRef = useRef<number | null>(null);
    const computed = w && h && w > 0 ? (h / Math.max(w, 1)) * 100 : 56.25; // default ~16:9
    if (ratioRef.current == null) ratioRef.current = computed;
    const ratio = ratioRef.current;
    // No logging: keep logic minimal to avoid console noise
    

    switch (m.mediaType) {
      case 'photo':
      case 'video':
      case 'animation':
        return (
          <div className="mt-1">
            <div className={box} ref={observeFile}>
              {(() => {
                // Use CSS aspect-ratio based on locked ratioRef to keep height stable
                const frameCls = "relative overflow-hidden";
                const arWidth = 100; // constant unit width
                const arHeight = ratio; // locked unit height (pct)
                const frameStyleBase: React.CSSProperties = {
                  width: '100%',
                  maxWidth: 'min(100%, 480px)',
                  maxHeight: '70svh',
                  aspectRatio: `${arWidth} / ${arHeight}`,
                };
                // full
                if (fullUrl) {
                  if (m.mediaType === 'video' || m.mediaType === 'animation') {
                    return (
                      <div className={frameCls} style={frameStyleBase}>
                        {videoFailed ? (
                          <div className="absolute inset-0 p-2">
                            <div className="text-sm text-gray-600">Неподдерживаемый формат видео в браузере</div>
                            <div className="mt-2 flex gap-3 text-sm">
                              <a className="text-blue-600 hover:underline" href={fullUrl} target="_blank" rel="noopener noreferrer">Открыть</a>
                              <a className="text-blue-600 hover:underline" href={fullUrl} download={m.fileName || `video-${m.msgId}.mp4`}>Скачать</a>
                            </div>
                          </div>
                        ) : (
                          <div className="absolute inset-0">
                            <VideoPlayer
                              src={fullUrl}
                              type={m.mediaMime || (m.fileName?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4')}
                              poster={thumbUrl}
                              controls={m.mediaType !== 'animation'}
                              autoPlay={m.mediaType === 'animation'}
                              muted={m.mediaType === 'animation'}
                              onClick={m.mediaType !== 'animation' ? () => openMedia(m) : undefined}
                              onError={() => setVideoFailed(true)}
                            />
                          </div>
                        )}
                      </div>
                    );
                  }
                  // photo
                  return (
                    <div className={frameCls} style={frameStyleBase}>
                      <img
                        src={fullUrl}
                        alt={m.fileName || 'media'}
                        className="absolute inset-0 w-full h-full object-contain"
                        onClick={() => openMedia(m)}
                      />
                    </div>
                  );
                }
                // thumb
                if (thumbUrl) {
                  return (
                    <div className={frameCls} style={frameStyleBase}>
                      <img
                        src={thumbUrl}
                        alt={m.fileName || 'thumb'}
                        className="absolute inset-0 w-full h-full object-contain"
                        onClick={() => openMedia(m)}
                      />
                    </div>
                  );
                }
                // skeleton
                return (
                  <div className="flex flex-col items-start gap-2">
                    <div className={frameCls} style={frameStyleBase}>
                      <div className="absolute inset-0">
                        <div className="w-full h-full bg-gray-200 rounded animate-pulse" />
                        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-2 bg-gradient-to-t from-black/30 to-transparent text-white text-xs">
                          <span className="opacity-90">Нет превью</span>
                          <button
                            className="underline"
                            onClick={() => {
                              requestedFilesRef.current.add(m.msgId);
                              onRequestFile?.(m.msgId);
                            }}
                          >
                            Загрузить {m.mediaType === 'photo' ? 'фото' : 'видео'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
            {/* Убрана дублирующая кнопка загрузки ниже. Кнопка осталась только в заглушке над скелетоном. */}
          </div>
        );
      case 'video_note': {
        // Рендер кружка: фиксированный круг, авто‑воспроизведение без контролов
        const sizePx = 240;
        return (
          <div className="mt-1">
            <div className="flex flex-col items-start gap-2">
              <div
                ref={observeFile}
                className="relative overflow-hidden rounded-full bg-gray-100 border border-gray-200"
                style={{ width: sizePx, height: sizePx, willChange: 'transform' as any, backfaceVisibility: 'hidden' as any }}
              >
                {fullUrl ? (
                  <video
                    className="absolute inset-0 w-full h-full object-cover"
                    src={fullUrl}
                    poster={thumbUrl}
                    loop
                    muted
                    autoPlay
                    playsInline
                    preload="metadata"
                    onClick={() => openMedia(m)}
                    onError={() => setVideoFailed(true)}
                  >
                    <source src={fullUrl} type={m.mediaMime || (m.fileName?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4')} />
                  </video>
                ) : thumbUrl ? (
                  <img
                    src={thumbUrl}
                    alt={m.fileName || 'video note'}
                    className="absolute inset-0 w-full h-full object-cover"
                    onClick={() => openMedia(m)}
                  />
                ) : (
                  <div className="absolute inset-0 bg-gray-200 animate-pulse" />
                )}
              </div>
              {!fullUrl && (
                <button
                  className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                  onClick={() => onRequestFile?.(m.msgId)}
                >
                  Загрузить кружок
                </button>
              )}
            </div>
          </div>
        );
      }
      case 'audio':
      case 'voice':
        return (
          <div className="mt-1 w-[320px] min-w-[260px] max-w-full">
            {fullUrl ? (
              <audio src={fullUrl} className="w-full" controls />
            ) : (
              <div className="text-xs text-gray-500">Нет файла</div>
            )}
            {!fullUrl && (
              <button
                className="mt-2 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                onClick={() => onRequestFile?.(m.msgId)}
              >
                Загрузить {m.mediaType === 'voice' ? 'голосовое' : 'аудио'}
              </button>
            )}
            {m.mediaType === 'voice' && m.mediaDuration && (
              <div className="mt-1 text-sm text-gray-700">{m.mediaDuration}s</div>
            )}
          </div>
        );
      case 'sticker':
        const isVideoSticker = /video\/(webm|mp4)/i.test(m.mediaMime || '');
        return (
          <div className="mt-1">
            {badge('Стикер')}
            <div className={box} ref={observeFile}>
              {fullUrl ? (
                isVideoSticker ? (
                  <video
                    src={fullUrl}
                    className="w-auto h-auto max-w-[85vw] md:max-w-[560px] max-h-[70vh] object-contain"
                    loop
                    muted
                    autoPlay
                    playsInline
                  />
                ) : (
                  <img
                    src={fullUrl}
                    alt={m.fileName || 'sticker'}
                    className="w-auto h-auto max-w-[85vw] md:max-w-[560px] max-h-[70vh] object-contain"
                  />
                )
              ) : (
                <div className="text-xs text-gray-500">Нет превью</div>
              )}
            </div>
            {!fullUrl && (
              <button
                className="mt-2 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                onClick={() => onRequestFile?.(m.msgId)}
              >
                Загрузить стикер
              </button>
            )}
          </div>
        );
      case 'document':
        return (
          <div className="mt-1">
            {badge('Документ')}
            <div className="mt-1 text-sm text-gray-700">
              {m.fileName || m.mediaMime || 'Файл'}{' '}
              {m.mediaSize ? `· ${(m.mediaSize / 1024 / 1024).toFixed(1)} MB` : ''}
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  // Album component
  const Album = ({ items, showAvatar }: { items: DBMessage[]; showAvatar: boolean }) => {
    const first = items[0];
    const cols = items.length === 2 ? 2 : items.length >= 3 ? 3 : 1;
    return (
      <div data-msg-id={first.msgId} className={`my-2 flex ${first.out ? 'justify-end' : 'justify-start'}`}>
        {!first.out && showAvatar && <Avatar senderName={first.senderName} fromId={first.fromId} />}
        <div
          className={`max-w-[85vw] md:max-w-[560px] border border-gray-200 rounded-xl px-3 py-2 overflow-hidden ${
            first.out ? 'bg-blue-100' : 'bg-white'
          } ${first.deleted ? 'opacity-70' : ''}`}
        >
          {!first.out && first.senderName && (
            <div className="text-xs text-sky-700 font-medium mb-1">{first.senderName}</div>
          )}
          {(first as any).forwardedFrom && (
            <div className="mb-1 text-xs text-gray-500">Переслано от {(first as any).forwardedFrom}</div>
          )}
          {typeof (first as any).replyToMsgId === 'number' && (
            <div className="mb-1">
              <ReplyPreview dialogId={first.dialogId} msgId={Number((first as any).replyToMsgId)} />
            </div>
          )}
          <div
            className={`grid gap-1 ${
              cols === 3 ? 'grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1'
            } [&_img]:w-full [&_img]:h-auto [&_video]:w-full [&_video]:h-auto`}
          >
            {items.map((it) => (
              <div key={it.id} className="[&>*]:w-full">
                <Media m={it} />
              </div>
            ))}
          </div>
          {first.text && (
            <div className="mt-1 whitespace-pre-wrap break-words">
              {renderRichText(first.text, (first as any).entities)}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2">
            <div className="text-[11px] text-gray-400">{new Date(first.date * 1000).toLocaleString()}</div>
            {first.edited && (
              <button className="text-[11px] text-blue-500 hover:underline" onClick={() => openHistory(first)}>
                (изменено)
              </button>
            )}
            {first.deleted && <span className="text-[11px] text-red-500">(удалено)</span>}
          </div>
        </div>
      </div>
    );
  };

  // Reply preview component
  const ReplyPreview = ({ dialogId, msgId }: { dialogId: string; msgId: number }) => {
    const [orig, setOrig] = useState<DBMessage | null>(null);
    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const id = msgKey(dialogId, msgId);
          const m = await db.messages.get(id);
          if (alive) setOrig(m || null);
        } catch {
          if (alive) setOrig(null);
        }
      })();
      return () => { alive = false; };
    }, [dialogId, msgId]);
    if (!orig) return (
      <div className="text-xs text-gray-400 border-l-2 border-gray-300 pl-2">Ответ на сообщение</div>
    );
    const labelByMedia: Record<string, string> = {
      photo: 'Фото',
      video: 'Видео',
      video_note: 'Кружок',
      audio: 'Аудио',
      voice: 'Голосовое',
      sticker: 'Стикер',
      document: 'Файл',
      animation: 'Анимация',
      unknown: 'Вложение',
    };
    const mediaLabel = orig.mediaType ? (labelByMedia[orig.mediaType] || 'Вложение') : undefined;
    const thumb = (orig as any).mediaThumb || getMsgBlobUrl(orig, 'thumb');
    const text = (orig.text || (mediaLabel ? `[${mediaLabel}] ${orig.fileName || ''}` : 'Сообщение')).trim();
    return (
      <div className="flex items-start gap-2 text-xs border-l-2 border-sky-300 pl-2">
        {thumb && (
          <img src={thumb} alt="thumb" className="w-8 h-8 object-cover rounded" />
        )}
        <div className="min-w-0">
          <div className="font-medium text-sky-700 truncate">{orig.senderName || 'Сообщение'}</div>
          <div className="text-gray-600 truncate max-w-[260px]">{text}</div>
        </div>
      </div>
    );
  };

  // Мемо-обёртки для локальных компонентов
  const MemoMessageItem = memo(
    MessageItem,
    (prev, next) => {
      const a = prev.m as any;
      const b = next.m as any;
      return (
        prev.showAvatar === next.showAvatar &&
        prev.m.msgId === next.m.msgId &&
        prev.m.deleted === next.m.deleted &&
        prev.m.edited === next.m.edited &&
        (prev.m.editVersion ?? 0) === (next.m.editVersion ?? 0) &&
        prev.m.mediaType === next.m.mediaType &&
        prev.m.mediaMime === next.m.mediaMime &&
        prev.m.fileName === next.m.fileName &&
        a.mediaBlob === b.mediaBlob &&
        a.mediaThumbBlob === b.mediaThumbBlob
      );
    }
  );

  const MemoAlbum = memo(
    Album,
    (prev, next) => {
      if (prev.showAvatar !== next.showAvatar) return false;
      if (prev.items.length !== next.items.length) return false;
      for (let i = 0; i < prev.items.length; i++) {
        const a: any = prev.items[i];
        const b: any = next.items[i];
        if (
          a.msgId !== b.msgId ||
          a.deleted !== b.deleted ||
          a.edited !== b.edited ||
          (a.editVersion ?? 0) !== (b.editVersion ?? 0) ||
          a.mediaType !== b.mediaType ||
          a.mediaMime !== b.mediaMime ||
          a.fileName !== b.fileName ||
          a.mediaBlob !== b.mediaBlob ||
          a.mediaThumbBlob !== b.mediaThumbBlob
        ) {
          return false;
        }
      }
      return true;
    }
  );

  // Message history
  

  // User avatars
  useEffect(() => {
    let cancelled = false;
    const ids = new Set(messages.map((m) => m.fromId).filter(Boolean) as string[]);
    const toLoad = Array.from(ids).filter((id) => !userAvatars.has(id));
    if (!toLoad.length) return;
    (async () => {
      const entries: Array<[string, string | undefined]> = [];
      for (const id of toLoad) {
        try {
          const u = await db.users.get(id);
          entries.push([id, (u as any)?.avatarSmall]);
        } catch {
          entries.push([id, undefined]);
        }
      }
      if (!cancelled) {
        setUserAvatars((prev) => new Map([...prev, ...entries]));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages]);

  // Dialog avatar
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentDialogId) {
        if (!cancelled) setDialogAvatar(undefined);
        return;
      }
      try {
        const dlg = await db.dialogs.get(currentDialogId);
        if (!cancelled) setDialogAvatar(dlg?.avatarSmall);
      } catch {
        if (!cancelled) setDialogAvatar(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDialogId]);

  // Auto-download stickers
  useEffect(() => {
    if (!onRequestFile) return;
    const toFetch = messages
      .filter((m) => m.mediaType === 'sticker' && !(m as any).mediaBlob)
      .slice(0, 12);
    if (!toFetch.length) return;
    let cancelled = false;
    (async () => {
      for (const m of toFetch) {
        if (cancelled) break;
        await onRequestFile(m.msgId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, onRequestFile]);

  // Auto-download newest media on dialog change
  useEffect(() => {
    if (!onRequestFile || !currentDialogId || currentDialogId === prevDialogIdRef.current) return;
    prevDialogIdRef.current = currentDialogId;
    const candidates = [...messages]
      .reverse()
      .filter((m) => m.mediaType && m.mediaType !== 'sticker' && !(m as any).mediaBlob)
      .filter((m) => (m.mediaSize ?? Infinity) <= 20 * 1024 * 1024)
      .slice(0, 10);
    if (!candidates.length) return;
    let cancelled = false;
    (async () => {
      for (const m of candidates) {
        if (cancelled) break;
        await onRequestFile(m.msgId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDialogId, messages, onRequestFile]);

  // Держать низ, если пользователь уже внизу (убирает подпрыгивания при апдейтах)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !currentDialogId) return;
    if (!didInitialScrollRef.current.get(currentDialogId)) return;
    if (!atBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - el.clientHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages.length, currentDialogId]);

  // Начальная прокрутка к последнему сообщению (один раз на диалог) после появления первых сообщений
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !currentDialogId) return;
    if (didInitialScrollRef.current.get(currentDialogId)) return;
    if (messages.length === 0) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - el.clientHeight;
      didInitialScrollRef.current.set(currentDialogId, true);
    });
    return () => cancelAnimationFrame(raf);
  }, [currentDialogId, messages.length]);

  // Infinite scroll loading (стабильно, не пересоздаём на каждое изменение messages)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!canLoadMoreTop && !canLoadMoreBottom) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          if (entry.target === topSentinelRef.current && canLoadMoreTop && !loadingTop) {
            const el2 = scrollerRef.current;
            const prevH = el2 ? el2.scrollHeight : 0;
            const prevTop = el2 ? el2.scrollTop : 0;
            setLoadingTop(true);
            onLoadMoreTop().finally(() => {
              setLoadingTop(false);
              // Сохранить видимую позицию после вставки сверху
              if (el2) {
                requestAnimationFrame(() => {
                  const dh = el2.scrollHeight - prevH;
                  if (dh > 0) el2.scrollTop = prevTop + dh;
                });
              }
            });
          } else if (entry.target === bottomSentinelRef.current && canLoadMoreBottom && !loadingBottom) {
            setLoadingBottom(true);
            onLoadMoreBottom().finally(() => setLoadingBottom(false));
          }
        });
      },
      { root: el, rootMargin: '120px', threshold: 0 }
    );
    if (topSentinelRef.current && canLoadMoreTop) observer.observe(topSentinelRef.current);
    if (bottomSentinelRef.current && canLoadMoreBottom) observer.observe(bottomSentinelRef.current);
    return () => observer.disconnect();
  }, [canLoadMoreTop, canLoadMoreBottom, loadingTop, loadingBottom]);
  // Обработчик скролла больше не сохраняет позиции и не автопрокручивает
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const bottomGap = el.scrollHeight - el.clientHeight - el.scrollTop;
    atBottomRef.current = bottomGap <= 4;
  }, []);

  // Date separators and avatar collapsing
  const isSameDay = (a: number, b: number) =>
    new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  const sameSender = (a?: DBMessage, b?: DBMessage) => a && b && a.fromId === b.fromId && a.out === b.out;
  const timeClose = (a?: DBMessage, b?: DBMessage) => a && b && Math.abs(a.date - b.date) <= 5 * 60;

  return (
    <div className="relative flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-auto p-2 md:p-3 bg-gray-50"
      >
        <div ref={topSentinelRef} style={{ height: 1, overflowAnchor: 'none' as any }} />
        {loadingTop && <div className="text-center text-gray-400 py-2">Загрузка...</div>}
        {!messages.length && <div className="text-gray-400">Нет сообщений</div>}
        {groups.map((g, idx) => {
          const first = g.items[0];
          const prevGroup = idx > 0 ? groups[idx - 1] : undefined;
          const prevLast = prevGroup ? prevGroup.items[prevGroup.items.length - 1] : undefined;
          const needDateSep = !prevLast || !isSameDay(prevLast.date, first.date);
          const showAvatar = !(sameSender(prevLast, first) && timeClose(prevLast, first));
          return (
            <React.Fragment key={g.key}>
              {needDateSep && (
                <div className="my-3 flex justify-center">
                  <span className="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-700">
                    {new Date(first.date * 1000).toLocaleDateString()}
                  </span>
                </div>
              )}
              {g.items.length > 1 ? (
                <MemoAlbum items={g.items} showAvatar={showAvatar} />
              ) : (
                <MemoMessageItem m={g.items[0]} showAvatar={showAvatar} />
              )}
            </React.Fragment>
          );
        })}
        <div ref={bottomSentinelRef} style={{ height: 1, overflowAnchor: 'auto' as any }} />
        {loadingBottom && <div className="text-center text-gray-400 py-2">Загрузка...</div>}
      </div>

      {/* Кнопка "вниз" удалена */}

      <MediaModal open={modalOpen} src={modalSrc} kind={modalKind} title={modalTitle} onClose={closeMediaModal} />

      {histOpen && (
        <div className="absolute inset-0 z-20 bg-black/30 flex items-center justify-center" onClick={() => setHistOpen(false)}>
          <div className="max-w-[520px] w-[90%] bg-white rounded-lg shadow-xl border border-gray-200 p-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">История изменений {histFor ? `#${histFor.msgId}` : ''}</div>
              <button className="text-gray-500 hover:text-gray-700" onClick={() => setHistOpen(false)}>
                ✕
              </button>
            </div>
            {histItems.length === 0 ? (
              <div className="text-sm text-gray-500">Нет сохранённых версий</div>
            ) : (
              <div className="max-h-[60vh] overflow-auto space-y-3">
                {[...histItems]
                  .sort((a, b) => b.version - a.version)
                  .map((v) => (
                    <div key={v.id} className="border border-gray-200 rounded p-2">
                      <div className="text-xs text-gray-500 mb-1">
                        Версия {v.version} · {new Date((v.editedAt || v.date) * 1000).toLocaleString()}
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words">{renderRichText(v.text, undefined)}</div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageList;