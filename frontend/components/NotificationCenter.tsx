'use client';

import React from 'react';
import Link from 'next/link';
import { Bell, CheckCheck, Circle } from 'lucide-react';
import { io, type Socket } from 'socket.io-client';
import { markAllNotificationsRead, markNotificationRead, notifications, SOCKET_URL } from '@/lib/api';
import type { AppNotification } from '@/types/api';

function priorityClass(priority: AppNotification['priority']) {
  return priority === 'HIGH' ? 'notification-high' : priority === 'LOW' ? 'notification-low' : 'notification-medium';
}

export function NotificationCenter() {
  const [items, setItems] = React.useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const socketRef = React.useRef<Socket | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const result = await notifications(false, 30);
      setItems(result.items);
      setUnreadCount(result.unreadCount);
    } catch {
      // Notification UI must not block the clinical workspace when the API is unavailable.
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const token = localStorage.getItem('apexcare_token');
    if (!token || token === 'demo-token') return;

    const socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket', 'polling'], reconnection: true });
    socketRef.current = socket;
    socket.on('notification:new', (notification: AppNotification) => {
      setItems((current) => [notification, ...current.filter((item) => item._id !== notification._id)].slice(0, 30));
      if (!notification.readAt) setUnreadCount((count) => count + 1);
    });
    socket.on('notification:read', ({ notificationId }: { notificationId: string }) => {
      setItems((current) => current.map((item) => item._id === notificationId ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadCount((count) => Math.max(0, count - 1));
    });
    socket.on('notification:all-read', () => {
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
      setUnreadCount(0);
    });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [refresh]);

  async function read(notification: AppNotification) {
    if (!notification.readAt) {
      try { await markNotificationRead(notification._id); } catch { return; }
      setItems((current) => current.map((item) => item._id === notification._id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadCount((count) => Math.max(0, count - 1));
    }
    setOpen(false);
  }

  async function readAll() {
    try { await markAllNotificationsRead(); } catch { return; }
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
  }

  return (
    <div className="notification-center">
      <button className="notification-bell" onClick={() => setOpen((value) => !value)} aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}>
        <Bell size={18} />
        {unreadCount > 0 && <span className="notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-panel glass">
          <div className="notification-panel-header">
            <div><b>Notifications</b><small>{unreadCount ? `${unreadCount} unread` : 'All caught up'}</small></div>
            {unreadCount > 0 && <button className="notification-read-all" onClick={readAll}><CheckCheck size={15} /> Mark all read</button>}
          </div>
          <div className="notification-list">
            {items.length === 0 ? <div className="notification-empty"><Bell size={18} /><span>No notifications yet.</span></div> : items.map((notification) => {
              const content = <div className={`notification-item ${notification.readAt ? 'read' : 'unread'} ${priorityClass(notification.priority)}`}>
                <div className="notification-item-top"><b>{notification.title}</b>{!notification.readAt && <Circle size={8} fill="currentColor" />}</div>
                <p>{notification.body}</p>
                <small>{new Date(notification.createdAt).toLocaleString()}</small>
              </div>;
              return notification.href ? <Link key={notification._id} href={notification.href} onClick={() => read(notification)}>{content}</Link> : <button key={notification._id} className="notification-button" onClick={() => read(notification)}>{content}</button>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
