import React, { useState, useEffect } from 'react'
import Interview from './components/Interview'
import Admin from './components/Admin'
import { Input, Button, Typography, Space, Card, Select } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import { fetchInterview } from './api'
import { buildCountryOptions } from './data/countries'

const { Title, Text } = Typography

export default function App() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [country, setCountry] = useState('')
  const [phone, setPhone] = useState('')
  const [countryOther, setCountryOther] = useState('')
  const [refSource, setRefSource] = useState('')
  const [refSourceOther, setRefSourceOther] = useState('')
  const [joined, setJoined] = useState(false)
  const [locked, setLocked] = useState(false)
  const [interview, setInterview] = useState(null)
  const [interviewLoading, setInterviewLoading] = useState(false)
  const [interviewError, setInterviewError] = useState('')

  const countryOptions = buildCountryOptions()

  const referralOptions = [
    { value: 'LinkedIn', label: 'LinkedIn' },
    { value: 'Indeed', label: 'Indeed' },
    { value: 'Dice', label: 'Dice' },
    { value: 'Glassdoor', label: 'Glassdoor' },
    { value: 'Monster', label: 'Monster' },
    { value: 'ZipRecruiter', label: 'ZipRecruiter' },
    { value: 'Wellfound (AngelList)', label: 'Wellfound (AngelList)' },
    { value: 'Company website', label: 'Company website' },
    { value: 'Google search', label: 'Google search' },
    { value: 'GitHub', label: 'GitHub' },
    { value: 'Discord', label: 'Discord' },
    { value: 'Facebook', label: 'Facebook' },
    { value: 'Reddit', label: 'Reddit' },
    { value: 'X (Twitter)', label: 'X (Twitter)' },
    { value: 'Telegram', label: 'Telegram' },
    { value: 'Referral (friend/colleague)', label: 'Referral (friend/colleague)' },
    { value: 'Other', label: 'Other' },
  ]

  const isValidEmail = (value) => {
    const v = String(value || '').trim()
    // Simple, practical email validation (avoids being overly strict)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  }

  const onNext = () => {
    if (!name.trim()) {
      return window.alert('Please enter your full name')
    }
    if (!email.trim()) {
      return window.alert('Please enter your email address')
    }
    if (!isValidEmail(email)) {
      return window.alert('Please enter a valid email address')
    }
    if (!country.trim()) {
      return window.alert('Please enter your country')
    }
    if (country === 'Other' && !String(countryOther || '').trim()) {
      return window.alert('Please enter your country')
    }
    if (!String(refSource || '').trim()) {
      return window.alert('Please select how you heard about us')
    }
    if (refSource === 'Other' && !String(refSourceOther || '').trim()) {
      return window.alert('Please specify how you heard about us')
    }
    if (localStorage.getItem('interview_locked') === 'true') {
      return window.alert('Interview already finished for this session')
    }
    setJoined(true)
  }

  // Simple routing: if path is /admin show admin page
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (pathname.startsWith('/admin')) return <Admin />

  // Interview session routing: /interview/:id
  const sessionMatch = pathname.match(/^\/interview\/([^/]+)\/?$/)
  const interviewId = sessionMatch ? sessionMatch[1] : null

  // If user visits /interview or /interview/ without an ID, show a friendly message.
  // This avoids letting candidates start an interview without an admin-created session link.
  if (pathname === '/interview' || pathname === '/interview/' || (pathname.startsWith('/interview') && !interviewId)) {
    return (
      <div className="app">
        <div className="candidate-page">
          <Card className="candidate-card" bordered={false} role="main">
            <Title level={3} className="candidate-title">Interview link required</Title>
            <Text className="candidate-subtitle">
              This page needs a valid interview session link. Please ask the recruiter/admin to send you the correct link.
            </Text>
          </Card>
        </div>
      </div>
    )
  }

  // Root (/) should not start an interview; candidates must use /interview/:id.
  if (!interviewId) {
    return (
      <div className="app">
        <div className="candidate-page">
          <Card className="candidate-card" bordered={false} role="main">
            <Title level={3} className="candidate-title">No active interview session</Title>
            <Text className="candidate-subtitle">
              Please open the interview session link provided by the admin (it looks like <strong>/interview/&lt;id&gt;</strong>).
            </Text>
          </Card>
        </div>
      </div>
    )
  }

  const resetLocked = () => {
    localStorage.removeItem('interview_locked')
    setLocked(false)
  }

  useEffect(() => {
    if (localStorage.getItem('interview_locked') === 'true') setLocked(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!interviewId) {
      setInterview(null)
      setInterviewError('')
      return
    }
    ;(async () => {
      setInterviewLoading(true)
      setInterviewError('')
      try {
        const data = await fetchInterview(interviewId)
        if (!cancelled) setInterview(data.interview || null)
      } catch (e) {
        if (!cancelled) setInterviewError('Invalid or expired interview link. Please ask the admin for a new link.')
      } finally {
        if (!cancelled) setInterviewLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [interviewId])

  if (joined) {
    const source = (refSource === 'Other') ? `Other: ${String(refSourceOther || '').trim()}` : refSource
    const finalCountry = (country === 'Other') ? String(countryOther || '').trim() : country
    return <Interview name={name} email={email} country={finalCountry} phone={phone} interviewId={interviewId} stack={interview?.stack} refSource={source} />
  }

  return (
    <div className="app">
      <div className="candidate-page">
        <Card className="candidate-card" bordered={false} role="main">
          <Title level={3} className="candidate-title">Candidate Information</Title>
          <Text className="candidate-subtitle">
            Please provide your information to continue with the interview. This information is required and cannot be skipped.
          </Text>

          {interviewId && (
            <div className="muted" style={{ marginBottom: 14 }}>
              <strong style={{ color: 'inherit' }}>Interview stack:</strong>{' '}
              {interviewLoading ? 'Loading…' : (interview?.stack || 'Unknown')}
              {interviewError ? <div style={{ marginTop: 6, color: '#ef4444' }}>{interviewError}</div> : null}
            </div>
          )}

          <div className="form-field form-field--first">
            <div className="field-label">
              Full Name <span className="field-required">*</span>
            </div>
            <Input
              size="large"
              prefix={<UserOutlined />}
              placeholder="Enter your full name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <div className="form-field">
            <div className="field-label">
              Email Address <span className="field-required">*</span>
            </div>
            <Input
              size="large"
              type="email"
              placeholder="Enter your email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>

          <div className="form-field">
            <div className="field-label">
              Country <span className="field-required">*</span>
            </div>
            <Select
              size="large"
              value={country || undefined}
              placeholder="Select your country"
              options={countryOptions}
              onChange={(val) => {
                setCountry(val)
                if (val !== 'Other') setCountryOther('')
              }}
              showSearch
              optionFilterProp="label"
            />
          </div>

          {country === 'Other' && (
            <div className="form-field">
              <div className="field-label">
                Please specify <span className="field-required">*</span>
              </div>
              <Input
                size="large"
                placeholder="Enter your country"
                value={countryOther}
                onChange={e => setCountryOther(e.target.value)}
              />
            </div>
          )}

          <div className="form-field">
            <div className="field-label">
              Phone Number <span className="muted">(optional)</span>
            </div>
            <Input
              size="large"
              placeholder="Phone number"
              value={phone}
              onChange={e => setPhone(e.target.value)}
            />
          </div>

          <div className="form-field">
            <div className="field-label">
              How did you hear about us? <span className="field-required">*</span>
            </div>
            <Select
              size="large"
              value={refSource || undefined}
              placeholder="Select an option"
              options={referralOptions}
              onChange={(val) => {
                setRefSource(val)
                if (val !== 'Other') setRefSourceOther('')
              }}
              showSearch
              optionFilterProp="label"
            />
          </div>

          {refSource === 'Other' && (
            <div className="form-field">
              <div className="field-label">
                Please specify <span className="field-required">*</span>
              </div>
              <Input
                size="large"
                placeholder="e.g., WhatsApp group, local job board, community…"
                value={refSourceOther}
                onChange={e => setRefSourceOther(e.target.value)}
              />
            </div>
          )}

          <Space direction="vertical" className="form-actions" style={{ width: '100%' }}>
            <Button type="primary" size="large" block onClick={onNext} disabled={locked || !!interviewError}>
              Continue to Interview
            </Button>
            {locked && (
              <Button danger size="middle" block onClick={resetLocked}>
                Reset interview on this device
              </Button>
            )}
          </Space>
        </Card>
      </div>
    </div>
  )
}
