// fetch-page.mjs SSRF 防护单测：纯函数 + 无需网络的 URL 校验（内网字面量/IP 字面量）
import { test } from "node:test";
import assert from "node:assert/strict";

const { isPrivateIP, isPrivateHostname, assertPublicUrl } = await import("../lib/fetch-page.mjs");

test("isPrivateIP：IPv4 私有/环回/链路本地/云元数据/共享地址命中", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1", "192.0.0.1"]) {
    assert.ok(isPrivateIP(ip), `${ip} 应判为私有`);
  }
});

test("isPrivateIP：公网 IPv4 不命中", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "114.114.114.114", "223.5.5.5", "172.32.0.1", "11.0.0.1"]) {
    assert.ok(!isPrivateIP(ip), `${ip} 不应判为私有`);
  }
});

test("isPrivateIP：IPv6 环回/未指定/链路本地/唯一本地/IPv4 映射命中", () => {
  for (const ip of ["::1", "::", "fe80::1", "febf::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1"]) {
    assert.ok(isPrivateIP(ip), `${ip} 应判为私有`);
  }
  assert.ok(!isPrivateIP("2606:4700:4700::1111"), "公网 IPv6 不命中");
});

test("isPrivateHostname：内部域名/IP 字面量命中（含尾点/IPv6 括号）", () => {
  for (const h of ["localhost", "foo.local", "foo.internal", "foo.home.arpa", "foo.lan", "127.0.0.1", "[::1]", "169.254.169.254"]) {
    assert.ok(isPrivateHostname(h), `${h} 应判为内网`);
  }
  assert.ok(!isPrivateHostname("www.baidu.com"), "公网域名不命中");
});

test("assertPublicUrl：非 http(s) 协议拒绝", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /http|https/);
  await assert.rejects(() => assertPublicUrl("ftp://example.com/"), /http|https/);
  await assert.rejects(() => assertPublicUrl("data:text/html,<h1>x</h1>"), /http|https/);
});

test("assertPublicUrl：内网/环回字面量拒绝（无需 DNS）", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/"), /内网|本机/);
  await assert.rejects(() => assertPublicUrl("http://localhost/"), /内网|本机/);
  await assert.rejects(() => assertPublicUrl("http://2130706433/"), /内网|本机/); // 十进制 IP → 归一化为 127.0.0.1
  await assert.rejects(() => assertPublicUrl("http://0x7f000001/"), /内网|本机/); // 十六进制 IP
  await assert.rejects(() => assertPublicUrl("http://[::1]/"), /内网|本机/);       // IPv6 环回
  await assert.rejects(() => assertPublicUrl("http://[::ffff:127.0.0.1]/"), /内网|本机/); // IPv4 映射
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/"), /内网|本机/);   // 云元数据
  await assert.rejects(() => assertPublicUrl("http://10.0.0.1/"), /内网|本机/);
});
